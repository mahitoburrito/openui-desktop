import type { CSSProperties } from "react";

// VS Code / Cursor chrome icon set (@vscode/codicons). One set, one voice:
// use these for workspace chrome (headers, panel toggles, view switchers).
export function Codicon({
  name,
  size,
  className,
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const utilitySize = className?.match(/(?:^|\s)(?:h|w)-(\d+(?:\.\d+)?)(?:\s|$)/)?.[1];
  const resolvedSize = size ?? (utilitySize ? Number(utilitySize) * 4 : 16);

  return (
    <i
      className={`codicon codicon-${name}${className ? ` ${className}` : ""}`}
      style={{ fontSize: resolvedSize, ...style }}
      aria-hidden="true"
    />
  );
}
