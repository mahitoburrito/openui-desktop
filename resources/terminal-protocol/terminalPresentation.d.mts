export type TerminalResizeMode = "fit" | "observe";

export interface TerminalPresentationInput {
  resizeMode: TerminalResizeMode;
  containerWidth: number;
  containerHeight: number;
  contentWidth: number;
  contentHeight: number;
}

export type TerminalPresentationPlan =
  | { kind: "fit" }
  | { kind: "none" }
  | { kind: "scale"; width: number; height: number; scale: number };

export function normalizeTerminalGrid(
  cols: number | undefined,
  rows: number | undefined,
): { cols: number; rows: number };

export function terminalMountCanResize(resizeMode: TerminalResizeMode): boolean;

export function observerTerminalGridSync(
  resizeMode: TerminalResizeMode,
  currentCols: number,
  currentRows: number,
  serverCols: number | undefined,
  serverRows: number | undefined,
): TerminalGrid | null;
export function planTerminalPresentation(input: TerminalPresentationInput): TerminalPresentationPlan;
