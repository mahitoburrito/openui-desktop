import type WebSocket from "ws";

export const TERMINAL_WS_MAX_PAYLOAD_BYTES = 128 * 1024;
export const TERMINAL_INPUT_MAX_BYTES = 64 * 1024;
export const TERMINAL_INPUT_BYTES_PER_SECOND = 4 * 1024 * 1024;
export const TERMINAL_WS_MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export type TerminalClientMessage =
  | { type: "input"; data: string; bytes: number }
  | { type: "terminalResponse"; data: string; bytes: number }
  | { type: "resize"; cols: number; rows: number };

export class TerminalClientMessageError extends Error {
  constructor(message: string, readonly closeCode: 1003 | 1007 | 1008 | 1009) {
    super(message);
    this.name = "TerminalClientMessageError";
  }
}

function rawDataBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data as ArrayBuffer);
}

export function parseTerminalClientMessage(
  data: WebSocket.RawData,
  isBinary: boolean,
): TerminalClientMessage {
  if (isBinary) throw new TerminalClientMessageError("Binary terminal messages are unsupported", 1003);
  const bytes = rawDataBuffer(data);
  if (bytes.byteLength > TERMINAL_WS_MAX_PAYLOAD_BYTES) {
    throw new TerminalClientMessageError("Terminal message is too large", 1009);
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TerminalClientMessageError("Malformed terminal message", 1007);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TerminalClientMessageError("Invalid terminal message", 1008);
  }

  const message = value as Record<string, unknown>;
  if (message.type === "input") {
    if (typeof message.data !== "string") {
      throw new TerminalClientMessageError("Terminal input must be text", 1008);
    }
    const inputBytes = Buffer.byteLength(message.data, "utf8");
    if (inputBytes > TERMINAL_INPUT_MAX_BYTES) {
      throw new TerminalClientMessageError("Terminal input is too large", 1009);
    }
    return { type: "input", data: message.data, bytes: inputBytes };
  }

  if (message.type === "terminalResponse") {
    if (typeof message.data !== "string") {
      throw new TerminalClientMessageError("Terminal response must be text", 1008);
    }
    const responseBytes = Buffer.byteLength(message.data, "utf8");
    if (responseBytes > TERMINAL_INPUT_MAX_BYTES) {
      throw new TerminalClientMessageError("Terminal response is too large", 1009);
    }
    const osc52Response = /^\x1b\]52;[cps];(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\x07$/.test(
      message.data,
    );
    const kittyMatch = /^\x1b\[\?(\d{1,2})u$/.exec(message.data);
    const kittyKeyboardResponse = Boolean(kittyMatch && Number(kittyMatch[1]) <= 31);
    // Emulator answers to a program's query, by final: DA1/2/3 (c), DSR (n), CPR (R),
    // XTSMGRAPHICS (S), window ops incl. the CSI 14/16/18 t size reports (t), and
    // DECRPM ($y). They reach the client as ordinary terminal output and have to go
    // back to the PTY, but they are not user input and must not be attributed as
    // such. The shape is what makes forwarding them safe: digits, separators and a
    // known final, so a program can never smuggle text or a newline into the tty
    // through its own query. `u` is excluded on purpose — the Kitty rule above owns
    // that final and is deliberately stricter.
    // CSI: DA1/2/3 (c), DSR (n), CPR (R), window ops incl. size reports (t),
    // XTSMGRAPHICS (S), focus in/out (I/O), DECRPM ($y). `u` is excluded on purpose —
    // the Kitty rule above owns that final and is stricter.
    const csiReportResponse = /^\x1b\[[?>]?[0-9;:]{0,64}(?:[cnRStIO]|\$y)$/.test(message.data);
    // OSC 4/10/11/12 colour reports. Editors and pagers query these to pick a light or
    // dark theme and block on the answer, so dropping them stalls them at startup.
    const oscColorResponse =
      /^\x1b\](?:4;\d{1,3}|1[012]);rgb:[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\/[0-9a-fA-F]{1,4}\x1b\\$/
        .test(message.data);
    // DCS DECRQSS status strings.
    const dcsStatusResponse = /^\x1bP[01]\$r[ -~]{0,64}\x1b\\$/.test(message.data);
    if (!osc52Response && !kittyKeyboardResponse && !csiReportResponse &&
        !oscColorResponse && !dcsStatusResponse) {
      throw new TerminalClientMessageError("Unsupported terminal response", 1008);
    }
    return { type: "terminalResponse", data: message.data, bytes: responseBytes };
  }

  if (message.type === "resize") {
    if (typeof message.cols !== "number" || typeof message.rows !== "number" ||
        !Number.isFinite(message.cols) || !Number.isFinite(message.rows)) {
      throw new TerminalClientMessageError("Invalid terminal dimensions", 1008);
    }
    return {
      type: "resize",
      cols: Math.max(2, Math.min(1_000, Math.floor(message.cols))),
      rows: Math.max(2, Math.min(1_000, Math.floor(message.rows))),
    };
  }

  throw new TerminalClientMessageError("Unsupported terminal message", 1008);
}

export class TerminalInputRateLimiter {
  private windowStartedAt = 0;
  private consumedBytes = 0;

  consume(bytes: number, now = Date.now()): boolean {
    if (this.windowStartedAt === 0 || now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.consumedBytes = 0;
    }
    this.consumedBytes += Math.max(0, bytes);
    return this.consumedBytes <= TERMINAL_INPUT_BYTES_PER_SECOND;
  }
}

export function sendTerminalMessage(client: WebSocket, payload: unknown): boolean {
  if (client.readyState !== 1) return false;
  let encoded: string;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    return false;
  }
  const queuedBytes = client.bufferedAmount + Buffer.byteLength(encoded, "utf8");
  if (queuedBytes > TERMINAL_WS_MAX_BUFFERED_BYTES) {
    try { client.close(1013, "Terminal client too slow"); } catch {}
    return false;
  }
  try {
    client.send(encoded, (error) => {
      if (!error) return;
      try { client.close(1011, "Terminal transport failed"); } catch {}
    });
    return true;
  } catch {
    try { client.close(1011, "Terminal transport failed"); } catch {}
    return false;
  }
}
