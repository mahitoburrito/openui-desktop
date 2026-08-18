import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Download,
  FileJson,
  FileText,
  Loader2,
  LockKeyhole,
  Share2,
  TerminalSquare,
  X,
} from "lucide-react";

type ShareFormat = "markdown" | "text" | "json";
type ShareScope = "selection" | "session";

interface SharePayload {
  filename: string;
  content: string;
  contentType: string;
  blockCount: number;
  redactionApplied: boolean;
  sensitive: boolean;
  truncated: boolean;
}

interface TerminalShareSheetProps {
  sessionId: string;
  sessionName: string;
  selectedBlockIds: string[];
  totalBlockCount: number;
  onClose: () => void;
}

const formats: Array<{ id: ShareFormat; label: string; detail: string; icon: typeof FileText }> = [
  { id: "markdown", label: "Markdown", detail: "Docs and issues", icon: FileText },
  { id: "text", label: "Plain text", detail: "Chat and email", icon: TerminalSquare },
  { id: "json", label: "JSON", detail: "Tools and archives", icon: FileJson },
];

async function readBody(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Share payload could not be created");
  return body as SharePayload;
}

export function TerminalShareSheet({
  sessionId,
  sessionName,
  selectedBlockIds,
  totalBlockCount,
  onClose,
}: TerminalShareSheetProps) {
  const [scope, setScope] = useState<ShareScope>(selectedBlockIds.length ? "selection" : "session");
  const [format, setFormat] = useState<ShareFormat>("markdown");
  const [includeOutput, setIncludeOutput] = useState(true);
  const [preserveAnsi, setPreserveAnsi] = useState(false);
  const [payload, setPayload] = useState<SharePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sensitiveConfirmationRequired, setSensitiveConfirmationRequired] = useState(false);
  const [confirmedSensitive, setConfirmedSensitive] = useState(false);
  const [copied, setCopied] = useState(false);

  const blockCount = scope === "selection" ? selectedBlockIds.length : totalBlockCount;
  const preview = useMemo(() => {
    if (!payload) return "";
    const limit = 20_000;
    return payload.content.length > limit
      ? `${payload.content.slice(0, limit)}\n\n… preview capped; copy or download contains the complete bounded payload …`
      : payload.content;
  }, [payload]);

  useEffect(() => {
    setConfirmedSensitive(false);
    setSensitiveConfirmationRequired(false);
  }, [scope, format, includeOutput, preserveAnsi, selectedBlockIds.join(",")]);

  useEffect(() => {
    if (scope === "selection" && selectedBlockIds.length === 0) setScope("session");
  }, [scope, selectedBlockIds.length]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      setCopied(false);
      try {
        const params = new URLSearchParams({
          format,
          includeOutput: String(includeOutput),
          outputMode: format === "json" && preserveAnsi ? "ansi" : "plain",
        });
        if (scope === "selection") params.set("blockIds", selectedBlockIds.join(","));
        if (confirmedSensitive) params.set("confirm", "share-sensitive-terminal-data");
        const response = await fetch(`/api/sessions/${sessionId}/share?${params}`, {
          signal: controller.signal,
        });
        if (response.status === 409 && !confirmedSensitive) {
          setPayload(null);
          setSensitiveConfirmationRequired(true);
          return;
        }
        const next = await readBody(response);
        setPayload(next);
        setSensitiveConfirmationRequired(false);
      } catch (loadError) {
        if ((loadError as Error).name !== "AbortError") {
          setPayload(null);
          setError(loadError instanceof Error ? loadError.message : "Share payload could not be created");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 120);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [confirmedSensitive, format, includeOutput, preserveAnsi, scope, selectedBlockIds, sessionId]);

  const copyPayload = async () => {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setError("Clipboard access was denied. Download the file instead.");
    }
  };

  const downloadPayload = () => {
    if (!payload) return;
    const url = URL.createObjectURL(new Blob([payload.content], { type: payload.contentType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = payload.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  return (
    <aside
      className="absolute inset-y-0 right-0 z-40 flex w-[min(390px,92%)] flex-col border-l border-[oklch(25%_0.008_260)] bg-[oklch(9%_0.005_260)] shadow-[-18px_0_45px_rgba(0,0,0,0.42)]"
      role="dialog"
      aria-label="Share terminal blocks"
      aria-modal="false"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="flex h-11 flex-shrink-0 items-center justify-between border-b border-[oklch(23%_0.007_260)] px-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Share2 className="h-3.5 w-3.5 text-[oklch(75%_0.11_48)]" />
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-zinc-100">Share terminal history</p>
            <p className="truncate text-[8px] text-zinc-600">{sessionName} · local export</p>
          </div>
        </div>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded text-zinc-600 hover:bg-zinc-800 hover:text-zinc-200" aria-label="Close share sheet">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-[oklch(22%_0.006_260)] p-3.5">
          <p className="mb-2 text-[8px] font-medium uppercase tracking-[0.12em] text-zinc-600">Scope</p>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              onClick={() => setScope("selection")}
              disabled={selectedBlockIds.length === 0}
              className={`rounded-md border px-3 py-2.5 text-left ${scope === "selection" ? "border-[oklch(52%_0.07_48)] bg-[oklch(17%_0.02_48)]" : "border-[oklch(25%_0.007_260)] bg-[oklch(11%_0.005_260)] hover:border-zinc-600"} disabled:cursor-not-allowed disabled:opacity-35`}
            >
              <span className="block text-[10px] font-medium text-zinc-200">Selection</span>
              <span className="mt-0.5 block text-[8px] text-zinc-600">{selectedBlockIds.length} block{selectedBlockIds.length === 1 ? "" : "s"}</span>
            </button>
            <button
              onClick={() => setScope("session")}
              className={`rounded-md border px-3 py-2.5 text-left ${scope === "session" ? "border-[oklch(52%_0.07_48)] bg-[oklch(17%_0.02_48)]" : "border-[oklch(25%_0.007_260)] bg-[oklch(11%_0.005_260)] hover:border-zinc-600"}`}
            >
              <span className="block text-[10px] font-medium text-zinc-200">Entire session</span>
              <span className="mt-0.5 block text-[8px] text-zinc-600">{totalBlockCount} blocks</span>
            </button>
          </div>
        </section>

        <section className="border-b border-[oklch(22%_0.006_260)] p-3.5">
          <p className="mb-2 text-[8px] font-medium uppercase tracking-[0.12em] text-zinc-600">Format</p>
          <div className="space-y-1.5">
            {formats.map(({ id, label, detail, icon: Icon }) => (
              <button key={id} onClick={() => setFormat(id)} className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left ${format === id ? "border-[oklch(46%_0.05_48)] bg-[oklch(16%_0.015_48)]" : "border-transparent hover:bg-zinc-900"}`}>
                <Icon className={`h-3.5 w-3.5 ${format === id ? "text-[oklch(76%_0.10_48)]" : "text-zinc-600"}`} />
                <span className="min-w-0 flex-1 text-[10px] text-zinc-300">{label}</span>
                <span className="text-[8px] text-zinc-600">{detail}</span>
                {format === id && <Check className="h-3 w-3 text-[oklch(76%_0.10_48)]" />}
              </button>
            ))}
          </div>
          <label className="mt-3 flex cursor-pointer items-center justify-between rounded-md border border-[oklch(24%_0.006_260)] bg-[oklch(11%_0.005_260)] px-3 py-2.5">
            <span><span className="block text-[10px] text-zinc-300">Include command output</span><span className="mt-0.5 block text-[8px] text-zinc-600">Commands and metadata are always included</span></span>
            <input type="checkbox" checked={includeOutput} onChange={(event) => setIncludeOutput(event.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-[oklch(65%_0.11_48)]" />
          </label>
          {format === "json" && (
            <label className="mt-1.5 flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-[9px] text-zinc-500 hover:bg-zinc-900">
              Preserve safe SGR color sequences
              <input type="checkbox" checked={preserveAnsi} onChange={(event) => setPreserveAnsi(event.target.checked)} className="h-3.5 w-3.5 rounded border-zinc-700 bg-zinc-900 text-[oklch(65%_0.11_48)]" />
            </label>
          )}
        </section>

        {sensitiveConfirmationRequired && !confirmedSensitive && (
          <section className="border-b border-[oklch(36%_0.05_65)] bg-[oklch(15%_0.02_65)] p-3.5">
            <div className="flex items-start gap-2.5">
              <LockKeyhole className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-[oklch(80%_0.10_65)]" />
              <div>
                <p className="text-[10px] font-medium text-[oklch(82%_0.08_65)]">Sensitive history detected</p>
                <p className="mt-1 text-[8px] leading-4 text-[oklch(70%_0.05_65)]">OpenUI will rescan and redact the selected payload. Nothing is uploaded.</p>
                <button onClick={() => setConfirmedSensitive(true)} className="mt-2 rounded bg-[oklch(65%_0.09_65)] px-2.5 py-1.5 text-[9px] font-medium text-[oklch(12%_0.02_65)]">Generate redacted preview</button>
              </div>
            </div>
          </section>
        )}

        <section className="p-3.5">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[8px] font-medium uppercase tracking-[0.12em] text-zinc-600">Preview</p>
            {payload && <div className="flex items-center gap-2 text-[8px] text-zinc-600"><span>{payload.blockCount} block{payload.blockCount === 1 ? "" : "s"}</span>{payload.redactionApplied && <span className="text-[oklch(78%_0.09_65)]">Redacted</span>}{payload.truncated && <span className="text-[oklch(76%_0.10_48)]">Truncated</span>}</div>}
          </div>
          <div className="min-h-44 overflow-hidden rounded-md border border-[oklch(24%_0.006_260)] bg-[oklch(7%_0.003_260)]">
            {loading && <div className="flex h-44 items-center justify-center text-zinc-700"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" /></div>}
            {!loading && error && <div className="flex min-h-44 items-start gap-2 p-3 text-[9px] leading-4 text-[oklch(76%_0.10_28)]"><AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />{error}</div>}
            {!loading && !error && !payload && !sensitiveConfirmationRequired && <div className="flex h-44 items-center justify-center text-[9px] text-zinc-700">No shareable blocks</div>}
            {!loading && payload && <pre className="m-0 max-h-[42vh] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[8px] leading-[1.65] text-zinc-500 selection:bg-[oklch(35%_0.06_48)]">{preview}</pre>}
          </div>
        </section>
      </div>

      <footer className="flex flex-shrink-0 items-center gap-2 border-t border-[oklch(23%_0.007_260)] bg-[oklch(8%_0.004_260)] p-3">
        <div className="mr-auto flex items-center gap-1.5 text-[8px] text-zinc-600"><LockKeyhole className="h-3 w-3" /> Local-only · server redacted</div>
        <button onClick={downloadPayload} disabled={!payload || loading} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[9px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-35"><Download className="h-3 w-3" /> Download</button>
        <button onClick={() => void copyPayload()} disabled={!payload || loading} className="flex h-8 items-center gap-1.5 rounded-md bg-zinc-100 px-3 text-[9px] font-medium text-zinc-900 hover:bg-white disabled:opacity-35">{copied ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}{copied ? "Copied" : `Copy ${blockCount}`}</button>
      </footer>
    </aside>
  );
}
