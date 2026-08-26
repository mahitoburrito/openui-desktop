function nonNegativeInteger(value = 0) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function bufferType(value) {
  return value === "alternate" ? "alternate" : "normal";
}

export function captureTerminalViewport(buffer = {}) {
  const baseY = nonNegativeInteger(buffer.baseY);
  const viewportY = Math.min(nonNegativeInteger(buffer.viewportY), baseY);
  return {
    bufferType: bufferType(buffer.type),
    viewportY,
    atBottom: viewportY >= baseY,
  };
}

export function terminalViewportTarget(anchor, buffer = {}) {
  const baseY = nonNegativeInteger(buffer.baseY);
  if (!anchor || anchor.bufferType !== bufferType(buffer.type) || anchor.atBottom) {
    return baseY;
  }
  return Math.min(nonNegativeInteger(anchor.viewportY), baseY);
}

export function terminalViewportRestoreAction(anchor, buffer = {}) {
  const target = terminalViewportTarget(anchor, buffer);
  const viewportY = nonNegativeInteger(buffer.viewportY);
  const baseY = nonNegativeInteger(buffer.baseY);
  if (viewportY === target && (bufferType(buffer.type) === "alternate" || target < baseY)) {
    return { kind: "none", target };
  }
  return target >= baseY
    ? { kind: "bottom", target }
    : { kind: "line", target };
}

export function terminalViewportScrollTop(target, baseY, scrollHeight, clientHeight) {
  const maximum = Math.max(0, nonNegativeInteger(scrollHeight) - nonNegativeInteger(clientHeight));
  const logicalBase = nonNegativeInteger(baseY);
  if (logicalBase === 0) return 0;
  return maximum * Math.min(nonNegativeInteger(target), logicalBase) / logicalBase;
}
