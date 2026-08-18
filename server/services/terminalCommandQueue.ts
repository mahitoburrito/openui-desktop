import { randomUUID } from "crypto";

export const TERMINAL_COMMAND_QUEUE_MAX_PENDING = 100;
export const TERMINAL_COMMAND_QUEUE_MAX_COMMAND_CHARS = 12_000;
export const TERMINAL_COMMAND_QUEUE_MAX_PENDING_BYTES = 512 * 1024;

export interface TerminalQueuedCommand {
  id: string;
  command: string;
  createdAt: number;
  updatedAt: number;
}

export interface TerminalCommandInFlight extends TerminalQueuedCommand {
  blockId?: string;
  startedAt?: number;
}

export interface TerminalCommandQueueSnapshot {
  sessionId: string;
  version: number;
  pending: TerminalQueuedCommand[];
  inFlight?: TerminalCommandInFlight;
}

interface TerminalCommandQueueState {
  version: number;
  pending: TerminalQueuedCommand[];
  inFlight?: TerminalCommandInFlight;
}

export class TerminalCommandQueueError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function copyItem<T extends TerminalQueuedCommand>(item: T): T {
  return { ...item };
}

function validateCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TerminalCommandQueueError("Command is required");
  }
  if (value.length > TERMINAL_COMMAND_QUEUE_MAX_COMMAND_CHARS) {
    throw new TerminalCommandQueueError(
      `Command exceeds ${TERMINAL_COMMAND_QUEUE_MAX_COMMAND_CHARS} characters`,
    );
  }
  if (value.includes("\0")) {
    throw new TerminalCommandQueueError("Command cannot contain NUL bytes");
  }
  return value;
}

function pendingBytes(items: TerminalQueuedCommand[]): number {
  return items.reduce((total, item) => total + Buffer.byteLength(item.command, "utf8"), 0);
}

/**
 * Runtime-only, per-session semantic command queues. This does not persist
 * commands across an app or PTY restart: reconnecting must never execute stale
 * work without the user who queued it still owning the live session.
 */
export class TerminalCommandQueueStore {
  private readonly states = new Map<string, TerminalCommandQueueState>();

  snapshot(sessionId: string): TerminalCommandQueueSnapshot {
    const state = this.states.get(sessionId);
    return {
      sessionId,
      version: state?.version || 0,
      pending: state?.pending.map(copyItem) || [],
      inFlight: state?.inFlight ? copyItem(state.inFlight) : undefined,
    };
  }

  enqueue(sessionId: string, rawCommand: unknown): TerminalQueuedCommand {
    const command = validateCommand(rawCommand);
    const state = this.state(sessionId);
    if (state.pending.length >= TERMINAL_COMMAND_QUEUE_MAX_PENDING) {
      throw new TerminalCommandQueueError("Terminal command queue is full", 409);
    }
    const commandBytes = Buffer.byteLength(command, "utf8");
    if (pendingBytes(state.pending) + commandBytes > TERMINAL_COMMAND_QUEUE_MAX_PENDING_BYTES) {
      throw new TerminalCommandQueueError("Terminal command queue byte limit exceeded", 409);
    }
    const now = Date.now();
    const item: TerminalQueuedCommand = {
      id: `terminal-command-${randomUUID()}`,
      command,
      createdAt: now,
      updatedAt: now,
    };
    state.pending.push(item);
    state.version++;
    return copyItem(item);
  }

  edit(sessionId: string, commandId: string, rawCommand: unknown): TerminalQueuedCommand {
    const command = validateCommand(rawCommand);
    const state = this.requiredState(sessionId);
    const item = state.pending.find((candidate) => candidate.id === commandId);
    if (!item) throw this.missingOrInFlight(state, commandId);
    const nextBytes = pendingBytes(state.pending) - Buffer.byteLength(item.command, "utf8") +
      Buffer.byteLength(command, "utf8");
    if (nextBytes > TERMINAL_COMMAND_QUEUE_MAX_PENDING_BYTES) {
      throw new TerminalCommandQueueError("Terminal command queue byte limit exceeded", 409);
    }
    item.command = command;
    item.updatedAt = Date.now();
    state.version++;
    return copyItem(item);
  }

  reorder(sessionId: string, commandId: string, beforeId?: string | null): TerminalQueuedCommand {
    const state = this.requiredState(sessionId);
    const index = state.pending.findIndex((candidate) => candidate.id === commandId);
    if (index < 0) throw this.missingOrInFlight(state, commandId);
    if (beforeId === commandId) return copyItem(state.pending[index]);
    const [item] = state.pending.splice(index, 1);
    if (beforeId) {
      const beforeIndex = state.pending.findIndex((candidate) => candidate.id === beforeId);
      if (beforeIndex < 0) {
        state.pending.splice(index, 0, item);
        throw new TerminalCommandQueueError("Queue position target not found", 404);
      }
      state.pending.splice(beforeIndex, 0, item);
    } else {
      state.pending.push(item);
    }
    item.updatedAt = Date.now();
    state.version++;
    return copyItem(item);
  }

  remove(sessionId: string, commandId: string): TerminalQueuedCommand {
    const state = this.requiredState(sessionId);
    const index = state.pending.findIndex((candidate) => candidate.id === commandId);
    if (index < 0) throw this.missingOrInFlight(state, commandId);
    const [item] = state.pending.splice(index, 1);
    state.version++;
    return copyItem(item);
  }

  beginDispatch(sessionId: string): TerminalQueuedCommand | null {
    const state = this.states.get(sessionId);
    if (!state || state.inFlight || state.pending.length === 0) return null;
    const item = state.pending.shift()!;
    state.inFlight = copyItem(item);
    state.version++;
    return copyItem(item);
  }

  markStarted(sessionId: string, commandId: string, blockId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state?.inFlight || state.inFlight.id !== commandId || state.inFlight.blockId) return false;
    state.inFlight.blockId = blockId;
    state.inFlight.startedAt = Date.now();
    state.version++;
    return true;
  }

  rollbackDispatch(sessionId: string, commandId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state?.inFlight || state.inFlight.id !== commandId || state.inFlight.blockId) return false;
    const { blockId: _blockId, startedAt: _startedAt, ...item } = state.inFlight;
    state.inFlight = undefined;
    state.pending.unshift(item);
    state.version++;
    return true;
  }

  abandonDispatch(sessionId: string, commandId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state?.inFlight || state.inFlight.id !== commandId) return false;
    state.inFlight = undefined;
    state.version++;
    return true;
  }

  completeBlock(sessionId: string, blockId: string): boolean {
    const state = this.states.get(sessionId);
    if (!state?.inFlight?.blockId || state.inFlight.blockId !== blockId) return false;
    state.inFlight = undefined;
    state.version++;
    return true;
  }

  clear(sessionId: string): number {
    const state = this.states.get(sessionId);
    if (!state) return 0;
    const count = state.pending.length + (state.inFlight ? 1 : 0);
    this.states.delete(sessionId);
    return count;
  }

  clearPending(sessionId: string): number {
    const state = this.states.get(sessionId);
    if (!state || state.pending.length === 0) return 0;
    const count = state.pending.length;
    state.pending = [];
    state.version++;
    return count;
  }

  private state(sessionId: string): TerminalCommandQueueState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { version: 0, pending: [] };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private requiredState(sessionId: string): TerminalCommandQueueState {
    const state = this.states.get(sessionId);
    if (!state) throw new TerminalCommandQueueError("Queued command not found", 404);
    return state;
  }

  private missingOrInFlight(state: TerminalCommandQueueState, commandId: string): TerminalCommandQueueError {
    return state.inFlight?.id === commandId
      ? new TerminalCommandQueueError("A running queued command cannot be changed", 409)
      : new TerminalCommandQueueError("Queued command not found", 404);
  }
}

export const terminalCommandQueue = new TerminalCommandQueueStore();
