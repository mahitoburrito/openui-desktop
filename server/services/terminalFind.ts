import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import type {
  TerminalCommandBlock,
  TerminalFindField,
  TerminalFindMatch,
  TerminalFindOrder,
  TerminalFindSnapshot,
  TerminalFindStatus,
} from "../types";
import { redactTerminalText } from "./terminalRedaction";
import { stripUnsafeTerminalControls } from "./terminalSharing";

const ALLOWED_FIELDS = new Set<TerminalFindField>(["command", "output", "note", "cwd"]);
const DEFAULT_FIELDS: TerminalFindField[] = ["command", "output"];
const MAX_QUERY_CHARS = 256;
const MAX_BLOCKS = 250;
const MAX_RETURNED_MATCHES = 100;
const MAX_HIDDEN_RANGES_PER_BLOCK = 128;
const MAX_HIDDEN_RANGES_TOTAL = 1_024;
const MAX_OUTPUT_LINE_INDEX = 10_000_000;
const DEFAULT_BLOCK_TIMEOUT_MS = 1_500;
const DEFAULT_TTL_MS = 2 * 60_000;
const MAX_JOB_AGE_MS = 5 * 60_000;
const INVALIDATION_DEBOUNCE_MS = 50;

export interface TerminalFindBlockIndexEntry {
  id: string;
  sequence: number;
}

export interface TerminalFindHiddenOutputLineRange {
  startLine: number;
  endLine: number;
}

export interface StartTerminalFindInput {
  sessionId: string;
  clientId?: string;
  query: string;
  regex?: boolean;
  caseSensitive?: boolean;
  fields?: TerminalFindField[];
  order?: TerminalFindOrder;
  blockIds?: string[];
  hiddenOutputLineRanges?: unknown;
  limit?: number;
  listBlocks: () => TerminalFindBlockIndexEntry[];
  readBlock: (blockId: string) => TerminalCommandBlock | null;
}

interface WorkerMatch {
  field: TerminalFindField;
  start: number;
  end: number;
  line: number;
  column: number;
  excerpt: string;
}

interface WorkerResponse {
  token: string;
  counts: Partial<Record<TerminalFindField, number>>;
  matches: WorkerMatch[];
  error?: string;
}

interface FindJob {
  id: string;
  sessionId: string;
  clientId?: string;
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  fields: TerminalFindField[];
  order: TerminalFindOrder;
  limit: number;
  selectedBlockIds?: Set<string>;
  hiddenOutputLineRanges: Map<string, TerminalFindHiddenOutputLineRange[]>;
  listBlocks: () => TerminalFindBlockIndexEntry[];
  readBlock: (blockId: string) => TerminalCommandBlock | null;
  worker: Worker;
  status: TerminalFindStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  blockIndex: Map<string, TerminalFindBlockIndexEntry>;
  blockVersions: Map<string, number>;
  blockCounts: Map<string, number>;
  blockMatches: Map<string, TerminalFindMatch[]>;
  scannedBlockIds: Set<string>;
  queue: string[];
  queued: Set<string>;
  current?: { blockId: string; version: number; token: string };
  currentTimer?: ReturnType<typeof setTimeout>;
  invalidationTimers: Map<string, ReturnType<typeof setTimeout>>;
  waiters: Set<() => void>;
  error?: string;
}

export class TerminalFindError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 429 = 400) {
    super(message);
  }
}

/**
 * This worker is serialized with Function#toString and evaluated in a Node
 * worker thread. Keep every helper self-contained: closure variables are not
 * available inside the worker.
 */
function terminalFindWorkerMain() {
  const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads");

  const stripControls = (value: string): string => {
    let result = "";
    for (let index = 0; index < value.length;) {
      const code = value.charCodeAt(index);
      if (code === 0x1b) {
        const family = value[index + 1];
        if (family === "[") {
          let end = index + 2;
          while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
          index = end < value.length ? end + 1 : value.length;
          continue;
        }
        if (family === "]" || family === "P" || family === "_" || family === "^" || family === "X") {
          index += 2;
          while (index < value.length) {
            if (value.charCodeAt(index) === 0x07) {
              index++;
              break;
            }
            if (value.charCodeAt(index) === 0x1b && value[index + 1] === "\\") {
              index += 2;
              break;
            }
            index++;
          }
          continue;
        }
        index += Math.min(2, value.length - index);
        continue;
      }
      if (code === 0x9b) {
        let end = index + 1;
        while (end < value.length && !/[\x40-\x7e]/.test(value[end])) end++;
        index = end < value.length ? end + 1 : value.length;
        continue;
      }
      if (code < 0x20 && ![0x08, 0x09, 0x0a, 0x0d].includes(code)) {
        index++;
        continue;
      }
      if (code === 0x7f) {
        index++;
        continue;
      }
      result += value[index++];
    }
    return result;
  };

  const outputToPlainText = (value: string): string => {
    const input = stripControls(value);
    const lines: string[] = [];
    let line: string[] = [];
    let cursor = 0;
    let lastWasCarriageReturn = false;
    const finishLine = () => {
      lines.push(line.join("").replace(/\s+$/g, ""));
      line = [];
      cursor = 0;
    };
    for (const character of input) {
      if (character === "\r") {
        cursor = 0;
        lastWasCarriageReturn = true;
      } else if (character === "\n") {
        finishLine();
        lastWasCarriageReturn = false;
      } else if (character === "\b") {
        cursor = Math.max(0, cursor - 1);
        lastWasCarriageReturn = false;
      } else if (character === "\t") {
        const spaces = 8 - (cursor % 8);
        for (let offset = 0; offset < spaces; offset++) line[cursor++] = " ";
        lastWasCarriageReturn = false;
      } else {
        line[cursor++] = character;
        lastWasCarriageReturn = false;
      }
    }
    if (line.length || lastWasCarriageReturn) finishLine();
    while (lines[0] === "") lines.shift();
    while (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  };

  const positionFor = (text: string, start: number): { line: number; column: number } => {
    let line = 0;
    let lastBreak = -1;
    for (let index = 0; index < start; index++) {
      if (text.charCodeAt(index) === 0x0a) {
        line++;
        lastBreak = index;
      }
    }
    return { line, column: start - lastBreak - 1 };
  };

  const excerptFor = (text: string, start: number, end: number): string => {
    const lineStart = Math.max(0, text.lastIndexOf("\n", start - 1) + 1);
    const nextBreak = text.indexOf("\n", end);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;
    const radiusStart = Math.max(lineStart, start - 80);
    const radiusEnd = Math.min(lineEnd, Math.max(end, start + 1) + 80);
    return `${radiusStart > lineStart ? "…" : ""}${text.slice(radiusStart, radiusEnd)}${radiusEnd < lineEnd ? "…" : ""}`;
  };

  const scanField = (input: {
    field: "command" | "output" | "note" | "cwd";
    value: string;
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    order: "newest-first" | "oldest-first";
    detailLimit: number;
    hiddenOutputLineRanges: Array<{ startLine: number; endLine: number }>;
  }): { count: number; matches: Array<{ field: string; start: number; end: number; line: number; column: number; excerpt: string }> } => {
    const text = input.field === "output" ? outputToPlainText(input.value) : stripControls(input.value);
    const positions: Array<{ start: number; end: number }> = [];
    let count = 0;
    const retain = (start: number, end: number) => {
      if (input.field === "output" && input.hiddenOutputLineRanges.length > 0) {
        const { line } = positionFor(text, start);
        if (input.hiddenOutputLineRanges.some((range) => line >= range.startLine && line <= range.endLine)) {
          return;
        }
      }
      count++;
      if (input.detailLimit <= 0) return;
      if (input.order === "oldest-first") {
        if (positions.length < input.detailLimit) positions.push({ start, end });
        return;
      }
      if (positions.length < input.detailLimit) {
        positions.push({ start, end });
      } else {
        positions[(count - 1) % input.detailLimit] = { start, end };
      }
    };

    if (input.regex) {
      const expression = new RegExp(input.query, `g${input.caseSensitive ? "" : "i"}u`);
      let match: RegExpExecArray | null;
      while ((match = expression.exec(text)) !== null) {
        retain(match.index, match.index + match[0].length);
        if (match[0].length === 0) {
          if (expression.lastIndex >= text.length) {
            expression.lastIndex = text.length + 1;
          } else {
            const codePoint = text.codePointAt(expression.lastIndex) || 0;
            expression.lastIndex += codePoint > 0xffff ? 2 : 1;
          }
        }
      }
    } else {
      const haystack = input.caseSensitive ? text : text.toLowerCase();
      const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
      let start = 0;
      while (start <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, start);
        if (index < 0) break;
        retain(index, index + needle.length);
        start = index + Math.max(1, needle.length);
      }
    }

    let ordered = positions;
    if (input.order === "newest-first") {
      if (count > input.detailLimit && input.detailLimit > 0) {
        const first = count % input.detailLimit;
        ordered = positions.slice(first).concat(positions.slice(0, first));
      }
      ordered = ordered.reverse();
    }
    return {
      count,
      matches: ordered.map(({ start, end }) => ({
        field: input.field,
        start,
        end,
        ...positionFor(text, start),
        excerpt: excerptFor(text, start, end),
      })),
    };
  };

  parentPort?.on("message", (request: {
    token: string;
    block: Record<string, string>;
    query: string;
    regex: boolean;
    caseSensitive: boolean;
    fields: Array<"command" | "output" | "note" | "cwd">;
    order: "newest-first" | "oldest-first";
    detailLimit: number;
    hiddenOutputLineRanges: Array<{ startLine: number; endLine: number }>;
  }) => {
    try {
      const newestPriority = ["output", "command", "note", "cwd"];
      const oldestPriority = ["cwd", "note", "command", "output"];
      const priority = request.order === "newest-first" ? newestPriority : oldestPriority;
      const fields = priority.filter((field) => request.fields.includes(field as any));
      const counts: Record<string, number> = {};
      const matches: any[] = [];
      for (const field of fields) {
        const result = scanField({
          field: field as any,
          value: request.block[field] || "",
          query: request.query,
          regex: request.regex,
          caseSensitive: request.caseSensitive,
          order: request.order,
          detailLimit: Math.max(0, request.detailLimit - matches.length),
          hiddenOutputLineRanges: request.hiddenOutputLineRanges,
        });
        counts[field] = result.count;
        matches.push(...result.matches);
      }
      parentPort?.postMessage({ token: request.token, counts, matches });
    } catch (error: any) {
      parentPort?.postMessage({ token: request.token, counts: {}, matches: [], error: error?.message || "Search failed" });
    }
  });
}

const WORKER_SOURCE = `(${terminalFindWorkerMain.toString()})()`;

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function terminalFindFields(value: unknown): TerminalFindField[] {
  if (value === undefined) return [...DEFAULT_FIELDS];
  if (!Array.isArray(value) || value.length === 0) {
    throw new TerminalFindError("fields must be a non-empty array");
  }
  const fields: TerminalFindField[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !ALLOWED_FIELDS.has(item as TerminalFindField)) {
      throw new TerminalFindError("fields may contain only command, output, note, and cwd");
    }
    if (!fields.includes(item as TerminalFindField)) fields.push(item as TerminalFindField);
  }
  return fields;
}

function terminalFindHiddenOutputLineRanges(
  value: unknown,
): Map<string, TerminalFindHiddenOutputLineRange[]> {
  if (value === undefined) return new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminalFindError("hiddenOutputLineRanges must be an object keyed by block ID");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_BLOCKS) {
    throw new TerminalFindError(`hiddenOutputLineRanges may reference at most ${MAX_BLOCKS} blocks`);
  }
  const result = new Map<string, TerminalFindHiddenOutputLineRange[]>();
  let totalRanges = 0;
  for (const [blockId, rawRanges] of entries) {
    if (!blockId || blockId.length > 512 || /[\x00-\x1f\x7f]/.test(blockId)) {
      throw new TerminalFindError("hiddenOutputLineRanges contains an invalid block ID");
    }
    if (!Array.isArray(rawRanges) || rawRanges.length > MAX_HIDDEN_RANGES_PER_BLOCK) {
      throw new TerminalFindError(
        `Each hidden output range list must contain at most ${MAX_HIDDEN_RANGES_PER_BLOCK} entries`,
      );
    }
    totalRanges += rawRanges.length;
    if (totalRanges > MAX_HIDDEN_RANGES_TOTAL) {
      throw new TerminalFindError(`hiddenOutputLineRanges may contain at most ${MAX_HIDDEN_RANGES_TOTAL} ranges`);
    }
    const ranges = rawRanges.map((raw): TerminalFindHiddenOutputLineRange => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new TerminalFindError("Each hidden output line range must be an object");
      }
      const keys = Object.keys(raw as Record<string, unknown>);
      if (keys.some((key) => key !== "startLine" && key !== "endLine")) {
        throw new TerminalFindError("Hidden output line ranges accept only startLine and endLine");
      }
      const startLine = (raw as any).startLine;
      const endLine = (raw as any).endLine;
      if (
        typeof startLine !== "number" ||
        typeof endLine !== "number" ||
        !Number.isSafeInteger(startLine) ||
        !Number.isSafeInteger(endLine) ||
        startLine < 0 ||
        endLine < startLine ||
        endLine > MAX_OUTPUT_LINE_INDEX
      ) {
        throw new TerminalFindError(
          `Hidden output lines must be inclusive integer ranges between 0 and ${MAX_OUTPUT_LINE_INDEX}`,
        );
      }
      return { startLine, endLine };
    }).sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

    const merged: TerminalFindHiddenOutputLineRange[] = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.startLine <= previous.endLine + 1) {
        previous.endLine = Math.max(previous.endLine, range.endLine);
      } else {
        merged.push({ ...range });
      }
    }
    if (merged.length > 0) result.set(blockId, merged);
  }
  return result;
}

function hiddenOutputRangesEqual(
  left: TerminalFindHiddenOutputLineRange[] | undefined,
  right: TerminalFindHiddenOutputLineRange[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((range, index) => (
    range.startLine === right[index].startLine && range.endLine === right[index].endLine
  ));
}

function safeBlock(block: TerminalCommandBlock): Record<TerminalFindField, string> {
  const command = redactTerminalText(stripUnsafeTerminalControls(block.command, false));
  const cwd = redactTerminalText(stripUnsafeTerminalControls(block.cwd, false), command.secrets);
  const note = redactTerminalText(
    stripUnsafeTerminalControls(block.note || "", false),
    [...command.secrets, ...cwd.secrets],
  );
  const output = redactTerminalText(
    stripUnsafeTerminalControls(block.output, false),
    [...command.secrets, ...cwd.secrets, ...note.secrets],
  );
  return { command: command.text, cwd: cwd.text, note: note.text, output: output.text };
}

export class TerminalFindService {
  private readonly jobs = new Map<string, FindJob>();
  private readonly clientJobs = new Map<string, string>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: {
    blockTimeoutMs?: number;
    ttlMs?: number;
    maxJobs?: number;
  } = {}) {
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30_000);
    this.cleanupTimer.unref?.();
  }

  start(input: StartTerminalFindInput): TerminalFindSnapshot {
    const sessionId = boundedText(input.sessionId, 256);
    if (!sessionId) throw new TerminalFindError("sessionId is required");
    if (typeof input.query !== "string") throw new TerminalFindError("query must be a string");
    const query = input.query.slice(0, MAX_QUERY_CHARS);
    if (!query) throw new TerminalFindError("query is required");
    if (input.query.length > MAX_QUERY_CHARS) {
      throw new TerminalFindError(`query must be at most ${MAX_QUERY_CHARS} characters`);
    }
    const regex = input.regex === true;
    if (regex) {
      try {
        new RegExp(query, `g${input.caseSensitive ? "" : "i"}u`);
      } catch (error: any) {
        throw new TerminalFindError(`Invalid regular expression: ${error.message}`);
      }
    }
    const fields = terminalFindFields(input.fields);
    if (input.order !== undefined && input.order !== "newest-first" && input.order !== "oldest-first") {
      throw new TerminalFindError("order must be newest-first or oldest-first");
    }
    const order: TerminalFindOrder = input.order === "oldest-first" ? "oldest-first" : "newest-first";
    const limit = Number.isFinite(input.limit)
      ? Math.max(1, Math.min(MAX_RETURNED_MATCHES, Math.floor(Number(input.limit))))
      : 100;
    if (typeof input.clientId === "string" && input.clientId.length > 128) {
      throw new TerminalFindError("clientId must be at most 128 characters");
    }
    const clientId = input.clientId === undefined ? undefined : boundedText(input.clientId, 128);
    if (input.clientId !== undefined && (!clientId || /[\x00-\x1f\x7f]/.test(clientId))) {
      throw new TerminalFindError("clientId must be a non-empty control-free string");
    }
    const selectedBlockIds = input.blockIds === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(input.blockIds) || input.blockIds.length > MAX_BLOCKS) {
            throw new TerminalFindError(`blockIds must contain at most ${MAX_BLOCKS} entries`);
          }
          if (input.blockIds.some((id) => (
            typeof id !== "string" || id.length === 0 || id.length > 512 || /[\x00-\x1f\x7f]/.test(id)
          ))) {
            throw new TerminalFindError("blockIds must contain non-empty control-free strings");
          }
          return new Set(input.blockIds);
        })();
    const hiddenOutputLineRanges = terminalFindHiddenOutputLineRanges(input.hiddenOutputLineRanges);

    const blockIndex = new Map(
      input.listBlocks()
        .filter((block) => !selectedBlockIds || selectedBlockIds.has(block.id))
        .slice(0, MAX_BLOCKS)
        .map((block) => [block.id, { id: block.id, sequence: block.sequence }]),
    );
    for (const blockId of hiddenOutputLineRanges.keys()) {
      if (!blockIndex.has(blockId)) {
        throw new TerminalFindError("hiddenOutputLineRanges must reference blocks included in this search");
      }
    }
    const clientKey = clientId ? `${sessionId}\0${clientId}` : undefined;
    if (clientKey) {
      const previous = this.clientJobs.get(clientKey);
      if (previous) this.cancel(previous);
    }
    this.makeRoom();
    const orderedIds = [...blockIndex.values()]
      .sort((a, b) => order === "newest-first" ? b.sequence - a.sequence : a.sequence - b.sequence)
      .map((block) => block.id);
    const worker = new Worker(WORKER_SOURCE, { eval: true });
    worker.unref();
    const now = Date.now();
    const job: FindJob = {
      id: `find-${randomUUID()}`,
      sessionId,
      clientId,
      query,
      regex,
      caseSensitive: input.caseSensitive === true,
      fields,
      order,
      limit,
      selectedBlockIds,
      hiddenOutputLineRanges,
      listBlocks: input.listBlocks,
      readBlock: input.readBlock,
      worker,
      status: orderedIds.length ? "scanning" : "complete",
      version: 1,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      blockIndex,
      blockVersions: new Map(orderedIds.map((id) => [id, 0])),
      blockCounts: new Map(),
      blockMatches: new Map(),
      scannedBlockIds: new Set(),
      queue: [...orderedIds],
      queued: new Set(orderedIds),
      invalidationTimers: new Map(),
      waiters: new Set(),
    };
    worker.on("message", (message: WorkerResponse) => this.onWorkerMessage(job.id, message));
    worker.on("error", (error) => this.fail(job.id, `Background search failed: ${error.message}`));
    worker.on("exit", (code) => {
      const current = this.jobs.get(job.id);
      if (current && current.status === "scanning" && code !== 0) {
        this.fail(job.id, "Background search exited unexpectedly");
      }
    });
    this.jobs.set(job.id, job);
    if (clientKey) this.clientJobs.set(clientKey, job.id);
    if (job.status === "scanning") setImmediate(() => this.dispatchNext(job.id));
    return this.snapshot(job);
  }

  get(id: string): TerminalFindSnapshot | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.lastAccessedAt = Date.now();
    return this.snapshot(job);
  }

  updateHiddenOutputLineRanges(id: string, value: unknown): TerminalFindSnapshot | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status === "cancelled" || job.status === "error") {
      throw new TerminalFindError("Terminal search is not active", 409);
    }
    const next = terminalFindHiddenOutputLineRanges(value);
    for (const blockId of next.keys()) {
      if (!job.blockIndex.has(blockId)) {
        throw new TerminalFindError("hiddenOutputLineRanges must reference blocks included in this search");
      }
    }
    const affected = new Set<string>();
    for (const blockId of new Set([...job.hiddenOutputLineRanges.keys(), ...next.keys()])) {
      if (!hiddenOutputRangesEqual(job.hiddenOutputLineRanges.get(blockId), next.get(blockId))) {
        affected.add(blockId);
      }
    }
    if (affected.size === 0) {
      job.lastAccessedAt = Date.now();
      return this.snapshot(job);
    }

    job.hiddenOutputLineRanges = next;
    for (const blockId of affected) {
      job.blockVersions.set(blockId, (job.blockVersions.get(blockId) || 0) + 1);
      job.blockCounts.delete(blockId);
      job.blockMatches.delete(blockId);
      job.scannedBlockIds.delete(blockId);
      this.enqueue(job, blockId, true);
    }
    job.status = "scanning";
    job.lastAccessedAt = Date.now();
    this.bump(job);
    if (!job.current) setImmediate(() => this.dispatchNext(job.id));
    return this.snapshot(job);
  }

  async waitForUpdate(id: string, afterVersion: number, waitMs: number): Promise<TerminalFindSnapshot | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.lastAccessedAt = Date.now();
    if (
      job.version > afterVersion ||
      job.status === "cancelled" ||
      job.status === "error" ||
      waitMs <= 0
    ) return this.snapshot(job);
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        job.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(1, Math.min(25_000, waitMs)));
      job.waiters.add(done);
    });
    return this.jobs.has(id) ? this.snapshot(job) : null;
  }

  cancel(id: string): TerminalFindSnapshot | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.status !== "cancelled" && job.status !== "error") {
      job.status = "cancelled";
      this.stopWorker(job);
      job.blockCounts.clear();
      job.blockMatches.clear();
      job.scannedBlockIds.clear();
      this.bump(job);
    }
    return this.snapshot(job);
  }

  cancelSession(sessionId: string) {
    for (const job of this.jobs.values()) {
      if (job.sessionId === sessionId) this.cancel(job.id);
    }
  }

  invalidateBlock(sessionId: string, blockId: string) {
    for (const job of this.jobs.values()) {
      if (job.sessionId !== sessionId || job.status === "cancelled" || job.status === "error") continue;
      if (job.selectedBlockIds && !job.selectedBlockIds.has(blockId)) continue;
      const existing = job.invalidationTimers.get(blockId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        job.invalidationTimers.delete(blockId);
        this.refreshBlock(job, blockId);
      }, INVALIDATION_DEBOUNCE_MS);
      timer.unref?.();
      job.invalidationTimers.set(blockId, timer);
    }
  }

  refreshSession(sessionId: string) {
    for (const job of this.jobs.values()) {
      if (job.sessionId !== sessionId || job.status === "cancelled" || job.status === "error") continue;
      const current = new Map(
        job.listBlocks()
          .filter((block) => !job.selectedBlockIds || job.selectedBlockIds.has(block.id))
          .slice(0, MAX_BLOCKS)
          .map((block) => [block.id, block]),
      );
      for (const id of job.blockIndex.keys()) {
        if (current.has(id)) continue;
        job.blockIndex.delete(id);
        job.blockVersions.delete(id);
        job.blockCounts.delete(id);
        job.blockMatches.delete(id);
        job.scannedBlockIds.delete(id);
        job.hiddenOutputLineRanges.delete(id);
        job.queue = job.queue.filter((queuedId) => queuedId !== id);
        job.queued.delete(id);
      }
      for (const block of current.values()) {
        const previous = job.blockIndex.get(block.id);
        job.blockIndex.set(block.id, { id: block.id, sequence: block.sequence });
        if (!previous) this.enqueue(job, block.id, true);
      }
      if (job.queue.length) {
        job.status = "scanning";
        if (!job.current) setImmediate(() => this.dispatchNext(job.id));
      }
      this.bump(job);
    }
  }

  shutdown() {
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) this.stopWorker(job);
    this.jobs.clear();
    this.clientJobs.clear();
  }

  private makeRoom() {
    const maximum = Math.max(1, this.options.maxJobs || 4);
    const terminalJobs = [...this.jobs.values()]
      .filter((job) => job.status === "cancelled" || job.status === "error")
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    while (this.jobs.size >= maximum * 4 && terminalJobs.length) {
      this.remove(terminalJobs.shift()!.id);
    }
    const activeCount = [...this.jobs.values()].filter((job) => (
      job.status === "scanning" || job.status === "complete"
    )).length;
    if (activeCount >= maximum) throw new TerminalFindError("Too many active terminal searches", 429);
  }

  private refreshBlock(job: FindJob, blockId: string) {
    const source = job.listBlocks().find((block) => block.id === blockId);
    if (!source) {
      job.blockIndex.delete(blockId);
      job.blockCounts.delete(blockId);
      job.blockMatches.delete(blockId);
      job.scannedBlockIds.delete(blockId);
      job.hiddenOutputLineRanges.delete(blockId);
      this.bump(job);
      return;
    }
    job.blockIndex.set(blockId, { id: blockId, sequence: source.sequence });
    job.blockVersions.set(blockId, (job.blockVersions.get(blockId) || 0) + 1);
    this.enqueue(job, blockId, true);
    if (job.status === "complete") job.status = "scanning";
    this.bump(job);
    if (!job.current) setImmediate(() => this.dispatchNext(job.id));
  }

  private enqueue(job: FindJob, blockId: string, priority: boolean) {
    if (job.queued.has(blockId)) {
      if (priority) {
        job.queue = [blockId, ...job.queue.filter((id) => id !== blockId)];
      }
      return;
    }
    if (priority) job.queue.unshift(blockId);
    else job.queue.push(blockId);
    job.queued.add(blockId);
  }

  private dispatchNext(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "scanning" || job.current) return;
    const blockId = job.queue.shift();
    if (!blockId) {
      job.status = "complete";
      this.bump(job);
      return;
    }
    job.queued.delete(blockId);
    const block = job.readBlock(blockId);
    if (!block) {
      job.blockIndex.delete(blockId);
      job.blockCounts.delete(blockId);
      job.blockMatches.delete(blockId);
      job.scannedBlockIds.delete(blockId);
      job.hiddenOutputLineRanges.delete(blockId);
      setImmediate(() => this.dispatchNext(id));
      return;
    }
    const version = job.blockVersions.get(blockId) || 0;
    const token = `${blockId}\0${version}\0${randomUUID()}`;
    job.current = { blockId, version, token };
    job.currentTimer = setTimeout(() => {
      this.fail(id, `Search timed out while scanning block ${block.sequence}`);
    }, Math.max(50, this.options.blockTimeoutMs || DEFAULT_BLOCK_TIMEOUT_MS));
    job.currentTimer.unref?.();
    job.worker.postMessage({
      token,
      block: safeBlock(block),
      query: job.query,
      regex: job.regex,
      caseSensitive: job.caseSensitive,
      fields: job.fields,
      order: job.order,
      detailLimit: job.limit,
      hiddenOutputLineRanges: job.hiddenOutputLineRanges.get(blockId) || [],
    });
  }

  private onWorkerMessage(id: string, message: WorkerResponse) {
    const job = this.jobs.get(id);
    if (!job || job.status !== "scanning" || !job.current || message.token !== job.current.token) return;
    if (job.currentTimer) clearTimeout(job.currentTimer);
    job.currentTimer = undefined;
    const { blockId, version } = job.current;
    job.current = undefined;
    if (message.error) {
      this.fail(id, `Search failed: ${message.error}`);
      return;
    }
    if ((job.blockVersions.get(blockId) || 0) !== version) {
      this.enqueue(job, blockId, true);
      setImmediate(() => this.dispatchNext(id));
      return;
    }
    const index = job.blockIndex.get(blockId);
    const source = job.readBlock(blockId);
    if (!index || !source) {
      setImmediate(() => this.dispatchNext(id));
      return;
    }
    const count = Object.values(message.counts).reduce((sum, value) => sum + (value || 0), 0);
    job.blockCounts.set(blockId, count);
    job.blockMatches.set(blockId, message.matches.map((match, matchIndex) => ({
      id: `${id}:${blockId}:${version}:${matchIndex}`,
      blockId,
      blockSequence: index.sequence,
      field: match.field,
      start: match.start,
      end: match.end,
      line: match.line,
      column: match.column,
      excerpt: match.excerpt,
      sensitive: Boolean(source.sensitive),
    })));
    job.scannedBlockIds.add(blockId);
    this.bump(job);
    setImmediate(() => this.dispatchNext(id));
  }

  private fail(id: string, message: string) {
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled" || job.status === "error") return;
    job.status = "error";
    job.error = message;
    this.stopWorker(job);
    this.bump(job);
  }

  private stopWorker(job: FindJob) {
    if (job.currentTimer) clearTimeout(job.currentTimer);
    job.currentTimer = undefined;
    for (const timer of job.invalidationTimers.values()) clearTimeout(timer);
    job.invalidationTimers.clear();
    job.worker.terminate().catch(() => undefined);
    for (const waiter of job.waiters) waiter();
    job.waiters.clear();
  }

  private bump(job: FindJob) {
    job.version++;
    job.updatedAt = Date.now();
    for (const waiter of [...job.waiters]) waiter();
  }

  private snapshot(job: FindJob): TerminalFindSnapshot {
    const orderedBlocks = [...job.blockIndex.values()].sort((a, b) => (
      job.order === "newest-first" ? b.sequence - a.sequence : a.sequence - b.sequence
    ));
    const allMatches = orderedBlocks.flatMap((block) => job.blockMatches.get(block.id) || []);
    const totalMatches = [...job.blockCounts.values()].reduce((sum, count) => sum + count, 0);
    const matches = allMatches.slice(0, job.limit);
    return {
      id: job.id,
      sessionId: job.sessionId,
      clientId: job.clientId,
      query: job.query,
      regex: job.regex,
      caseSensitive: job.caseSensitive,
      fields: [...job.fields],
      order: job.order,
      status: job.status,
      version: job.version,
      totalBlocks: job.blockIndex.size,
      scannedBlocks: job.scannedBlockIds.size,
      totalMatches,
      returnedMatches: matches.length,
      hiddenOutputRangeCount: [...job.hiddenOutputLineRanges.values()].reduce(
        (total, ranges) => total + ranges.length,
        0,
      ),
      truncated: totalMatches > matches.length,
      matches,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private cleanupExpired() {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const expired = job.status === "scanning"
        ? now - job.createdAt > MAX_JOB_AGE_MS
        : now - job.lastAccessedAt > (this.options.ttlMs || DEFAULT_TTL_MS);
      if (expired) this.remove(job.id);
    }
  }

  private remove(id: string) {
    const job = this.jobs.get(id);
    if (!job) return;
    this.stopWorker(job);
    this.jobs.delete(id);
    if (job.clientId) {
      const key = `${job.sessionId}\0${job.clientId}`;
      if (this.clientJobs.get(key) === id) this.clientJobs.delete(key);
    }
  }
}

export const terminalFind = new TerminalFindService();
