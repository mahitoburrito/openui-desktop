import type { CSSProperties } from "react";

// VS Code / Cursor chrome icon set (@vscode/codicons). One set, one voice:
// use these for workspace chrome (headers, panel toggles, view switchers).
export function Codicon({
  name,
  size = 16,
  className,
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <i
      className={`codicon codicon-${name}${className ? ` ${className}` : ""}`}
      style={{ fontSize: size, ...style }}
      aria-hidden="true"
    />
  );
}
