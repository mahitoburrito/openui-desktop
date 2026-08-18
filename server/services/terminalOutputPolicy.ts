export type TerminalOsc52ClipboardAccess = "deny" | "write_only" | "read_write";

export const TERMINAL_OSC52_MAX_SEQUENCE_CHARS = 64 * 1024;
const OSC_COMMAND_PREFIX_CHARS = 16;

export interface TerminalOutputPolicyResult {
  displayData: string;
  recordData: string;
  blockedReads: number;
  blockedWrites: number;
  malformed: number;
  oversized: number;
}

function emptyResult(): TerminalOutputPolicyResult {
  return {
    displayData: "",
    recordData: "",
    blockedReads: 0,
    blockedWrites: 0,
    malformed: 0,
    oversized: 0,
  };
}

export function terminalOsc52ClipboardAccess(
  environment: Record<string, string | undefined> = process.env,
): TerminalOsc52ClipboardAccess {
  const configured = environment.OPENUI_OSC52_CLIPBOARD_ACCESS?.trim().toLowerCase();
  return configured === "write_only" || configured === "read_write" ? configured : "deny";
}

function nextOsc(input: string, start: number): { index: number; introducerLength: number } | null {
  const esc = input.indexOf("\x1b]", start);
  const c1 = input.indexOf("\x9d", start);
  if (esc < 0 && c1 < 0) return null;
  if (esc >= 0 && (c1 < 0 || esc < c1)) return { index: esc, introducerLength: 2 };
  return { index: c1, introducerLength: 1 };
}

function oscTerminator(
  input: string,
  start: number,
): { index: number; length: number } | null {
  const bel = input.indexOf("\x07", start);
  const st = input.indexOf("\x1b\\", start);
  const c1st = input.indexOf("\x9c", start);
  const candidates = [
    bel >= 0 ? { index: bel, length: 1 } : null,
    st >= 0 ? { index: st, length: 2 } : null,
    c1st >= 0 ? { index: c1st, length: 1 } : null,
  ].filter((entry): entry is { index: number; length: number } => Boolean(entry));
  return candidates.sort((left, right) => left.index - right.index)[0] || null;
}

type OscCommand = string | "invalid" | undefined;

function oscCommand(candidate: string, introducerLength: number): OscCommand {
  const content = candidate.slice(introducerLength);
  const separator = content.indexOf(";");
  if (separator >= 0) {
    const command = content.slice(0, separator);
    return /^\d+$/.test(command) ? command : "invalid";
  }
  if (content.length <= OSC_COMMAND_PREFIX_CHARS && /^\d*$/.test(content)) return undefined;
  return "invalid";
}

function osc52Operation(
  sequence: string,
  introducerLength: number,
  terminatorLength: number,
): { read: boolean } | null {
  const payload = sequence.slice(introducerLength, sequence.length - terminatorLength);
  const first = payload.indexOf(";");
  const second = payload.indexOf(";", first + 1);
  if (first < 0 || second < 0 || payload.slice(0, first) !== "52") return null;
  const selection = payload.slice(first + 1, second);
  const data = payload.slice(second + 1);
  if (!/^[cps]$/.test(selection)) return null;
  return { read: data === "?" };
}

/**
 * Enforces terminal OSC 52 clipboard access before bytes reach semantic
 * history or a renderer. Non-OSC-52 bytes are preserved exactly, including
 * arbitrary chunk boundaries and C1 OSC/ST forms.
 */
export class TerminalOutputPolicy {
  private carry = "";
  private discardingOversizedOsc52 = false;
  private discardTrailingEscape = false;

  constructor(readonly osc52Access: TerminalOsc52ClipboardAccess = "deny") {}

  feed(chunk: string): TerminalOutputPolicyResult {
    const result = emptyResult();
    let input = chunk;

    if (this.discardingOversizedOsc52) {
      input = `${this.discardTrailingEscape ? "\x1b" : ""}${input}`;
      this.discardTrailingEscape = false;
      const terminator = oscTerminator(input, 0);
      if (!terminator) {
        this.discardTrailingEscape = input.endsWith("\x1b");
        return result;
      }
      this.discardingOversizedOsc52 = false;
      input = input.slice(terminator.index + terminator.length);
    }

    input = this.carry + input;
    this.carry = "";
    let cursor = 0;
    const appendBoth = (value: string) => {
      result.displayData += value;
      result.recordData += value;
    };

    while (cursor < input.length) {
      const osc = nextOsc(input, cursor);
      if (!osc) {
        const remaining = input.slice(cursor);
        if (remaining.endsWith("\x1b")) {
          appendBoth(remaining.slice(0, -1));
          this.carry = "\x1b";
        } else {
          appendBoth(remaining);
        }
        break;
      }

      appendBoth(input.slice(cursor, osc.index));
      const payloadStart = osc.index + osc.introducerLength;
      const terminator = oscTerminator(input, payloadStart);
      if (!terminator) {
        const pending = input.slice(osc.index);
        const command = oscCommand(pending, osc.introducerLength);
        if (command === "52") {
          if (pending.length <= TERMINAL_OSC52_MAX_SEQUENCE_CHARS) {
            this.carry = pending;
          } else {
            this.discardingOversizedOsc52 = true;
            this.discardTrailingEscape = pending.endsWith("\x1b");
            result.oversized++;
          }
        } else if (command === undefined) {
          this.carry = pending;
        } else {
          appendBoth(pending);
        }
        break;
      }

      const end = terminator.index + terminator.length;
      const sequence = input.slice(osc.index, end);
      const command = oscCommand(sequence, osc.introducerLength);
      if (command !== "52") {
        appendBoth(sequence);
        cursor = end;
        continue;
      }

      if (sequence.length > TERMINAL_OSC52_MAX_SEQUENCE_CHARS) {
        result.oversized++;
        cursor = end;
        continue;
      }
      const operation = osc52Operation(sequence, osc.introducerLength, terminator.length);
      if (!operation) {
        result.malformed++;
        cursor = end;
        continue;
      }

      const allowed = operation.read
        ? this.osc52Access === "read_write"
        : this.osc52Access === "write_only" || this.osc52Access === "read_write";
      if (allowed) {
        result.displayData += sequence;
      } else if (operation.read) {
        result.blockedReads++;
      } else {
        result.blockedWrites++;
      }
      // Clipboard payloads are control-plane data, never semantic history.
      cursor = end;
    }

    return result;
  }

  flush(): TerminalOutputPolicyResult {
    const result = emptyResult();
    if (this.carry) {
      const introducerLength = this.carry.startsWith("\x1b]") ? 2 : 1;
      if (oscCommand(this.carry, introducerLength) !== "52") {
        result.displayData = this.carry;
        result.recordData = this.carry;
      }
    }
    this.reset();
    return result;
  }

  reset() {
    this.carry = "";
    this.discardingOversizedOsc52 = false;
    this.discardTrailingEscape = false;
  }
}
