import { useMemo } from "react";
import {
  toSplitRows,
  type DiffLine,
  type SplitRow,
} from "./diffModel";
import type { Highlight, HighlightToken } from "./useHighlighter";

// Render one line's content as Shiki-colored spans. Meta/hunk lines stay plain.
function HighlightedContent({
  line,
  filePath,
  highlight,
}: {
  line: DiffLine;
  filePath: string;
  highlight: Highlight;
}) {
  if (line.type === "hunk" || line.type === "meta") {
    return <span>{line.text || " "}</span>;
  }
  const tokens: HighlightToken[] = highlight(line.content, filePath);
  return (
    <>
      {tokens.map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.text}
        </span>
      ))}
    </>
  );
}

const bgFor = (t: DiffLine["type"]) =>
  t === "add"
    ? "bg-green-500/10"
    : t === "del"
      ? "bg-red-500/10"
      : t === "hunk"
        ? "bg-blue-500/10"
        : "";

const markerFor = (t: DiffLine["type"]) =>
  t === "add" ? "+" : t === "del" ? "−" : " ";

const wrapCls = (wrap: boolean) =>
  wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre";

// ── Unified ───────────────────────────────────────────────────────────────────

export function UnifiedDiff({
  lines,
  filePath,
  highlight,
  wrap,
}: {
  lines: DiffLine[];
  filePath: string;
  highlight: Highlight;
  wrap: boolean;
}) {
  return (
    <div className="text-[12px] leading-[1.5] font-mono">
      {lines.map((line, i) => {
        if (line.type === "meta") {
          return (
            <div key={i} className="px-4 text-zinc-600 whitespace-pre-wrap break-all">
              {line.text || " "}
            </div>
          );
        }
        const isCode = line.type === "add" || line.type === "del" || line.type === "ctx";
        return (
          <div key={i} className={`flex ${bgFor(line.type)}`}>
            <span className="flex-shrink-0 w-10 select-none text-right pr-1 text-[10px] text-zinc-600 border-r border-border/40">
              {line.oldNo ?? ""}
            </span>
            <span className="flex-shrink-0 w-10 select-none text-right pr-1 text-[10px] text-zinc-600 border-r border-border/40">
              {line.newNo ?? ""}
            </span>
            <span
              className={`flex-shrink-0 w-4 select-none text-center ${
                line.type === "add"
                  ? "text-green-400"
                  : line.type === "del"
                    ? "text-red-400"
                    : "text-zinc-700"
              }`}
            >
              {line.type === "hunk" ? "" : markerFor(line.type)}
            </span>
            <span className={`flex-1 min-w-0 pr-4 ${wrapCls(wrap)}`}>
              {isCode ? (
                <HighlightedContent line={line} filePath={filePath} highlight={highlight} />
              ) : (
                line.text || " "
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ── Split ─────────────────────────────────────────────────────────────────────

function SplitCell({
  line,
  side,
  filePath,
  highlight,
  wrap,
}: {
  line: DiffLine | null;
  side: "left" | "right";
  filePath: string;
  highlight: Highlight;
  wrap: boolean;
}) {
  if (!line) {
    return <div className="flex-1 min-w-0 bg-zinc-500/[0.03]" />;
  }
  const no = side === "left" ? line.oldNo : line.newNo;
  return (
    <div className={`flex-1 min-w-0 flex ${bgFor(line.type)}`}>
      <span className="flex-shrink-0 w-10 select-none text-right pr-1 text-[10px] text-zinc-600 border-r border-border/40">
        {no ?? ""}
      </span>
      <span
        className={`flex-shrink-0 w-4 select-none text-center ${
          line.type === "add"
            ? "text-green-400"
            : line.type === "del"
              ? "text-red-400"
              : "text-zinc-700"
        }`}
      >
        {markerFor(line.type)}
      </span>
      <span className={`flex-1 min-w-0 pr-2 ${wrapCls(wrap)}`}>
        <HighlightedContent line={line} filePath={filePath} highlight={highlight} />
      </span>
    </div>
  );
}

export function SplitDiff({
  lines,
  filePath,
  highlight,
  wrap,
}: {
  lines: DiffLine[];
  filePath: string;
  highlight: Highlight;
  wrap: boolean;
}) {
  const rows: SplitRow[] = useMemo(() => toSplitRows(lines), [lines]);
  return (
    <div className="text-[12px] leading-[1.5] font-mono">
      {rows.map((row, i) => {
        if (row.kind === "meta") {
          return (
            <div key={i} className="px-4 text-zinc-600 whitespace-pre-wrap break-all">
              {row.full?.text || " "}
            </div>
          );
        }
        if (row.kind === "hunk") {
          return (
            <div key={i} className="px-4 bg-blue-500/10 text-blue-300 whitespace-pre-wrap break-all">
              {row.full?.text || " "}
            </div>
          );
        }
        return (
          <div key={i} className="flex">
            <SplitCell line={row.left} side="left" filePath={filePath} highlight={highlight} wrap={wrap} />
            <div className="w-px bg-border flex-shrink-0" />
            <SplitCell line={row.right} side="right" filePath={filePath} highlight={highlight} wrap={wrap} />
          </div>
        );
      })}
    </div>
  );
}
