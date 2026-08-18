import { useMemo } from "react";
import { Loader2, Undo2 } from "../icons";
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

function HunkRejectButton({
  hunkIndex,
  rejectingHunkIndex,
  onRejectHunk,
}: {
  hunkIndex: number | null;
  rejectingHunkIndex?: number | null;
  onRejectHunk?: (hunkIndex: number) => void;
}) {
  if (hunkIndex === null || !onRejectHunk) return null;
  const rejecting = rejectingHunkIndex === hunkIndex;
  return (
    <button
      type="button"
      onClick={() => onRejectHunk(hunkIndex)}
      disabled={rejecting}
      className="flex-shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-blue-200/70 hover:text-red-200 hover:bg-red-500/10 disabled:opacity-60 disabled:hover:text-blue-200/70 disabled:hover:bg-transparent transition-colors"
      title="Reject this hunk"
    >
      {rejecting ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <Undo2 className="w-3 h-3" />
      )}
      Reject
    </button>
  );
}

const diffVar = (name: string) => `var(${name})`;

// ── Unified ───────────────────────────────────────────────────────────────────

export function UnifiedDiff({
  lines,
  filePath,
  highlight,
  wrap,
  canRejectHunks = false,
  rejectingHunkIndex,
  onRejectHunk,
}: {
  lines: DiffLine[];
  filePath: string;
  highlight: Highlight;
  wrap: boolean;
  canRejectHunks?: boolean;
  rejectingHunkIndex?: number | null;
  onRejectHunk?: (hunkIndex: number) => void;
}) {
  return (
    <div className="text-[12px] leading-[1.5] font-mono">
      {lines.map((line, i) => {
        if (line.type === "meta") {
          return (
            <div
              key={i}
              className="px-4 whitespace-pre-wrap break-all"
              style={{ color: diffVar("--diff-muted") }}
            >
              {line.text || " "}
            </div>
          );
        }
        const isCode = line.type === "add" || line.type === "del" || line.type === "ctx";
        return (
          <div key={i} className={`flex ${bgFor(line.type)}`}>
            <span
              className="flex-shrink-0 w-10 select-none text-right pr-1 text-[10px] border-r"
              style={{
                backgroundColor: diffVar("--diff-gutter"),
                borderColor: diffVar("--diff-border"),
                color: diffVar("--diff-muted"),
              }}
            >
              {line.oldNo ?? ""}
            </span>
            <span
              className="flex-shrink-0 w-10 select-none text-right pr-1 text-[10px] border-r"
              style={{
                backgroundColor: diffVar("--diff-gutter"),
                borderColor: diffVar("--diff-border"),
                color: diffVar("--diff-muted"),
              }}
            >
              {line.newNo ?? ""}
            </span>
            <span
              className={`flex-shrink-0 w-4 select-none text-center ${
                line.type === "add"
                  ? "text-green-400"
                  : line.type === "del"
                    ? "text-red-400"
                    : ""
              }`}
              style={line.type === "ctx" ? { color: diffVar("--diff-muted") } : undefined}
            >
              {line.type === "hunk" ? "" : markerFor(line.type)}
            </span>
            <span className={`flex-1 min-w-0 pr-4 ${wrapCls(wrap)}`}>
              {line.type === "hunk" ? (
                <span className="flex min-w-0 items-center justify-between gap-3 text-blue-300">
                  <span className="flex-1 min-w-0 truncate">{line.text || " "}</span>
                  {canRejectHunks && (
                    <HunkRejectButton
                      hunkIndex={line.hunkIndex}
                      rejectingHunkIndex={rejectingHunkIndex}
                      onRejectHunk={onRejectHunk}
                    />
                  )}
                </span>
              ) : isCode ? (
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
    return (
      <div
        className="flex-1 min-w-0"
        style={{ backgroundColor: "color-mix(in oklab, var(--diff-gutter), transparent 54%)" }}
      />
    );
  }
  const no = side === "left" ? line.oldNo : line.newNo;
  return (
    <div className={`flex-1 min-w-0 flex ${bgFor(line.type)}`}>
      <span
        className="flex-shrink-0 w-10 select-none text-right pr-1 text-[10px] border-r"
        style={{
          backgroundColor: diffVar("--diff-gutter"),
          borderColor: diffVar("--diff-border"),
          color: diffVar("--diff-muted"),
        }}
      >
        {no ?? ""}
      </span>
      <span
        className={`flex-shrink-0 w-4 select-none text-center ${
          line.type === "add"
            ? "text-green-400"
            : line.type === "del"
              ? "text-red-400"
              : ""
        }`}
        style={line.type === "ctx" ? { color: diffVar("--diff-muted") } : undefined}
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
  canRejectHunks = false,
  rejectingHunkIndex,
  onRejectHunk,
}: {
  lines: DiffLine[];
  filePath: string;
  highlight: Highlight;
  wrap: boolean;
  canRejectHunks?: boolean;
  rejectingHunkIndex?: number | null;
  onRejectHunk?: (hunkIndex: number) => void;
}) {
  const rows: SplitRow[] = useMemo(() => toSplitRows(lines), [lines]);
  return (
    <div className="text-[12px] leading-[1.5] font-mono">
      {rows.map((row, i) => {
        if (row.kind === "meta") {
          return (
            <div
              key={i}
              className="px-4 whitespace-pre-wrap break-all"
              style={{ color: diffVar("--diff-muted") }}
            >
              {row.full?.text || " "}
            </div>
          );
        }
        if (row.kind === "hunk") {
          return (
            <div key={i} className="px-4 bg-blue-500/10 text-blue-300">
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className={`${wrapCls(wrap)} flex-1 min-w-0`}>{row.full?.text || " "}</span>
                {canRejectHunks && (
                  <HunkRejectButton
                    hunkIndex={row.full?.hunkIndex ?? null}
                    rejectingHunkIndex={rejectingHunkIndex}
                    onRejectHunk={onRejectHunk}
                  />
                )}
              </div>
            </div>
          );
        }
        return (
          <div key={i} className="flex">
            <SplitCell line={row.left} side="left" filePath={filePath} highlight={highlight} wrap={wrap} />
            <div className="w-px flex-shrink-0" style={{ backgroundColor: diffVar("--diff-border") }} />
            <SplitCell line={row.right} side="right" filePath={filePath} highlight={highlight} wrap={wrap} />
          </div>
        );
      })}
    </div>
  );
}
