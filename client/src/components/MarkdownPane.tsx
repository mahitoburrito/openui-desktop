import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  X,
  FileText,
  Loader2,
  RefreshCw,
  Code,
  Eye,
  Copy,
  Check,
} from "lucide-react";

interface Props {
  path: string;
  isActive?: boolean;
  onClose: () => void;
  onClick?: () => void;
}

interface FileData {
  path: string;
  name: string;
  size: number;
  modified: number;
  content: string;
}

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function MarkdownPane({ path, isActive, onClose, onClick }: Props) {
  const [data, setData] = useState<FileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const reqIdRef = useRef(0);

  const load = () => {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    fetch(`/api/files/read?path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((d) => {
        if (id !== reqIdRef.current) return;
        if (d.error) {
          setError(d.error);
          setData(null);
        } else {
          setData(d);
        }
      })
      .catch((e) => {
        if (id !== reqIdRef.current) return;
        setError(e.message || "Failed to load");
      })
      .finally(() => {
        if (id === reqIdRef.current) setLoading(false);
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const html = useMemo(() => {
    if (!data) return "";
    try {
      const raw = marked.parse(data.content, { async: false }) as string;
      return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
    } catch (e: any) {
      return `<p style="color:#ef4444">Render error: ${e.message}</p>`;
    }
  }, [data]);

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const fileName = path.split("/").pop() || path;
  const dirPath = path.substring(0, path.length - fileName.length).replace(/\/$/, "");

  return (
    <div
      className={`flex flex-col h-full min-h-0 transition-colors ${
        isActive ? "bg-canvas" : "bg-canvas-dark"
      }`}
      onClick={onClick}
      style={{
        outline: isActive ? "1px solid #3b82f640" : "none",
      }}
    >
      {/* Pane header */}
      <div
        className="flex-shrink-0 h-9 px-2.5 flex items-center justify-between border-b border-border"
        style={{
          backgroundColor: isActive ? "#3b82f608" : "transparent",
        }}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
          <span className="text-[12px] font-medium text-white truncate" title={path}>
            {fileName}
          </span>
          {dirPath && (
            <span className="text-[10px] text-zinc-600 font-mono truncate hidden md:inline">
              {dirPath}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleCopyPath();
            }}
            className="w-6 h-6 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-surface-active transition-colors"
            title="Copy path"
          >
            {copied ? (
              <Check className="w-3 h-3 text-green-400" />
            ) : (
              <Copy className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setShowRaw((v) => !v);
            }}
            className={`w-6 h-6 rounded flex items-center justify-center transition-colors ${
              showRaw
                ? "text-blue-400 bg-blue-500/10"
                : "text-zinc-600 hover:text-zinc-300 hover:bg-surface-active"
            }`}
            title={showRaw ? "Show rendered" : "Show source"}
          >
            {showRaw ? <Eye className="w-3 h-3" /> : <Code className="w-3 h-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              load();
            }}
            className="w-6 h-6 rounded flex items-center justify-center text-zinc-600 hover:text-zinc-300 hover:bg-surface-active transition-colors"
            title="Reload"
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
            className="w-6 h-6 rounded flex items-center justify-center text-zinc-600 hover:text-white hover:bg-surface-active transition-colors"
            title="Close pane"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-y-auto bg-canvas">
        {loading && (
          <div className="flex items-center justify-center h-full text-zinc-500 text-xs gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}
        {!loading && error && (
          <div className="flex items-center justify-center h-full text-red-400 text-xs px-6 text-center">
            {error}
          </div>
        )}
        {!loading && !error && data && (
          showRaw ? (
            <pre className="p-5 text-[12px] font-mono text-zinc-300 whitespace-pre-wrap break-words">
              {data.content}
            </pre>
          ) : (
            <div
              className="markdown-body p-6 max-w-3xl mx-auto"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )
        )}
      </div>
    </div>
  );
}
