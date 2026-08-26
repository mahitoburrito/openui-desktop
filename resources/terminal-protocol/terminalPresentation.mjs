const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const MAX_TERMINAL_DIMENSION = 1_000;

function terminalDimension(value, fallback) {
  if (!Number.isFinite(value) || value < 2) return fallback;
  return Math.min(MAX_TERMINAL_DIMENSION, Math.floor(value));
}

function positivePixels(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

export function normalizeTerminalGrid(cols, rows) {
  return {
    cols: terminalDimension(cols, DEFAULT_TERMINAL_COLS),
    rows: terminalDimension(rows, DEFAULT_TERMINAL_ROWS),
  };
}

export function terminalMountCanResize(resizeMode) {
  return resizeMode !== "observe";
}

export function observerTerminalGridSync(resizeMode, currentCols, currentRows, serverCols, serverRows) {
  if (terminalMountCanResize(resizeMode)) return null;
  const current = normalizeTerminalGrid(currentCols, currentRows);
  const server = normalizeTerminalGrid(serverCols, serverRows);
  return current.cols === server.cols && current.rows === server.rows ? null : server;
}

export function planTerminalPresentation({
  resizeMode,
  containerWidth,
  containerHeight,
  contentWidth,
  contentHeight,
}) {
  if (terminalMountCanResize(resizeMode)) return { kind: "fit" };

  const width = positivePixels(contentWidth);
  const height = positivePixels(contentHeight);
  const availableWidth = positivePixels(containerWidth);
  const availableHeight = positivePixels(containerHeight);
  if (width === 0 || height === 0 || availableWidth === 0 || availableHeight === 0) {
    return { kind: "none" };
  }

  return {
    kind: "scale",
    width,
    height,
    // Overview cards are a live tail, not a miniature of the entire viewport.
    // Fit the width and let the bottom-anchored, overflow-hidden host crop older
    // rows. Scaling all rows into the card makes a normal 80x24 grid unreadable.
    scale: Math.min(1, availableWidth / width),
  };
}
