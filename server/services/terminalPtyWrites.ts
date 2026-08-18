import type { IPty } from "node-pty";

export const TERMINAL_PTY_WRITE_CHUNK_BYTES = 4 * 1024;
export const TERMINAL_PTY_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
export const TERMINAL_PTY_WRITE_PACING_MS = 1;
export const TERMINAL_BRACKETED_PASTE_START = "\x1b[200~";
export const TERMINAL_BRACKETED_PASTE_END = "\x1b[201~";

export type TerminalPtyWriteKind =
  | "user"
  | "command"
  | "bootstrap"
  | "automation"
  | "upload"
  | "replay"
  | "terminal-response"
  | "queued-command";

export interface TerminalPtyWriteOptions {
  kind?: TerminalPtyWriteKind;
  chunkBytes?: number;
  interChunkDelayMs?: number;
  beforeWrite?: () => void;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
}

interface WriteChunk {
  data: string;
  bytes: number;
}

interface PendingWrite {
  kind: TerminalPtyWriteKind;
  chunks: WriteChunk[];
  index: number;
  remainingBytes: number;
  interChunkDelayMs: number;
  beforeWrite?: () => void;
  onComplete?: () => void;
  onError?: (error: unknown) => void;
  started: boolean;
}

export function decorateTerminalPtyWrite(
  data: string,
  options: { bracketedPaste?: boolean; clearLine?: boolean; submit?: boolean } = {},
): string {
  const body = options.bracketedPaste && data
    ? `${TERMINAL_BRACKETED_PASTE_START}${data}${TERMINAL_BRACKETED_PASTE_END}`
    : data;
  const editable = options.clearLine ? `\x15${body}` : body;
  return options.submit ? `${editable}\r` : editable;
}

/** Split a JavaScript string without ever cutting a UTF-8 code point. */
export function splitTerminalWrite(data: string, maxBytes = TERMINAL_PTY_WRITE_CHUNK_BYTES): WriteChunk[] {
  const limit = Math.max(256, Math.min(64 * 1024, Math.floor(maxBytes)));
  const chunks: WriteChunk[] = [];
  let current = "";
  let currentBytes = 0;

  for (const character of data) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + characterBytes > limit) {
      chunks.push({ data: current, bytes: currentBytes });
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) chunks.push({ data: current, bytes: currentBytes });
  return chunks;
}

export class TerminalPtyWriteCoordinator {
  private readonly queue: PendingWrite[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private generation = 0;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly pty: IPty,
    private readonly isCurrent: () => boolean,
    private readonly maxQueuedBytes = TERMINAL_PTY_MAX_QUEUED_BYTES,
  ) {}

  enqueue(data: string, options: TerminalPtyWriteOptions = {}): boolean {
    if (this.disposed || !this.isCurrent()) return false;
    if (!data) {
      try {
        options.beforeWrite?.();
        options.onComplete?.();
        return true;
      } catch (error) {
        options.onError?.(error);
        return false;
      }
    }

    const chunks = splitTerminalWrite(data, options.chunkBytes);
    const bytes = chunks.reduce((total, chunk) => total + chunk.bytes, 0);
    if (bytes > this.maxQueuedBytes || this.queuedBytes + bytes > this.maxQueuedBytes) return false;

    this.queue.push({
      kind: options.kind || "user",
      chunks,
      index: 0,
      remainingBytes: bytes,
      interChunkDelayMs: Math.max(0, Math.min(100, Math.floor(
        options.interChunkDelayMs ?? (chunks.length > 1 ? TERMINAL_PTY_WRITE_PACING_MS : 0),
      ))),
      beforeWrite: options.beforeWrite,
      onComplete: options.onComplete,
      onError: options.onError,
      started: false,
    });
    this.queuedBytes += bytes;
    this.pump();
    return true;
  }

  get pendingBytes(): number {
    return this.queuedBytes;
  }

  get pendingWrites(): number {
    return this.queue.length;
  }

  whenIdle(): Promise<void> {
    if (this.queue.length === 0 && !this.timer) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  flush() {
    this.pump();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.resolveIdle();
  }

  private pump() {
    if (this.disposed || this.timer || this.queue.length === 0) {
      if (this.queue.length === 0 && !this.timer) this.resolveIdle();
      return;
    }
    if (!this.isCurrent()) {
      this.dispose();
      return;
    }

    const pending = this.queue[0];
    if (!pending.started) {
      try {
        pending.beforeWrite?.();
        pending.started = true;
      } catch (error) {
        this.failCurrent(error);
        return;
      }
    }

    const chunk = pending.chunks[pending.index];
    try {
      this.pty.write(chunk.data);
    } catch (error) {
      this.failCurrent(error);
      return;
    }
    pending.index++;
    pending.remainingBytes -= chunk.bytes;
    this.queuedBytes = Math.max(0, this.queuedBytes - chunk.bytes);

    if (pending.index >= pending.chunks.length) {
      this.queue.shift();
      try { pending.onComplete?.(); } catch {}
      queueMicrotask(() => this.pump());
      return;
    }

    const generation = this.generation;
    if (pending.interChunkDelayMs > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (!this.disposed && generation === this.generation) this.pump();
      }, pending.interChunkDelayMs);
    } else {
      queueMicrotask(() => {
        if (!this.disposed && generation === this.generation) this.pump();
      });
    }
  }

  private failCurrent(error: unknown) {
    const pending = this.queue.shift();
    if (pending) {
      this.queuedBytes = Math.max(0, this.queuedBytes - pending.remainingBytes);
      try { pending.onError?.(error); } catch {}
    }
    queueMicrotask(() => this.pump());
  }

  private resolveIdle() {
    if (this.queue.length > 0 || this.timer) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
