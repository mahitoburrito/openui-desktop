export type TerminalBufferType = "normal" | "alternate";

export interface TerminalViewportBuffer {
  viewportY: number;
  baseY: number;
  type: TerminalBufferType;
}

export interface TerminalViewportAnchor {
  bufferType: TerminalBufferType;
  viewportY: number;
  atBottom: boolean;
}

export type TerminalViewportRestoreAction =
  | { kind: "none"; target: number }
  | { kind: "bottom"; target: number }
  | { kind: "line"; target: number };

export function captureTerminalViewport(buffer: TerminalViewportBuffer): TerminalViewportAnchor;
export function terminalViewportTarget(
  anchor: TerminalViewportAnchor | undefined,
  buffer: TerminalViewportBuffer,
): number;
export function terminalViewportRestoreAction(
  anchor: TerminalViewportAnchor | undefined,
  buffer: TerminalViewportBuffer,
): TerminalViewportRestoreAction;
export function terminalViewportScrollTop(
  target: number,
  baseY: number,
  scrollHeight: number,
  clientHeight: number,
): number;
