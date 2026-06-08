import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Minimize2,
  RotateCw,
  ArrowLeft,
  ArrowRight,
  Globe,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { useStore } from "../stores/useStore";

// Normalize what the user types into a loadable URL. Bare hosts/ports get
// http://, so "localhost:3000" and "example.com" both work.
function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/.*)?$/.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

interface NativeBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export function BrowserView() {
  const { viewMode, setViewMode, browserUrl, setBrowserUrl } = useStore();

  const isNativeBrowser = Boolean(window.electronAPI?.isElectron);
  const [input, setInput] = useState(browserUrl);
  // The URL actually loaded in the iframe (committed on submit/reload).
  const [src, setSrc] = useState(browserUrl ? normalizeUrl(browserUrl) : "");
  const [loadKey, setLoadKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nativeState, setNativeState] = useState<NativeBrowserState>({
    url: "",
    title: "",
    canGoBack: false,
    canGoForward: false,
    loading: false,
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (viewMode !== "browser") return;

    setInput(browserUrl);

    const nextSrc = browserUrl ? normalizeUrl(browserUrl) : "";
    if (!nextSrc || nextSrc === src) return;
    if (isNativeBrowser && nativeState.url && normalizeUrl(nativeState.url) === nextSrc) return;

    setSrc(nextSrc);
    setLoadFailed(false);
    loadedRef.current = false;
    setLoadKey((k) => k + 1);
  }, [browserUrl, isNativeBrowser, nativeState.url, src, viewMode]);

  useEffect(() => {
    if (!isNativeBrowser || !window.electronAPI) return;
    window.electronAPI.on("browser:state", (state: NativeBrowserState) => {
      setNativeState(state);
      if (state.url) {
        setInput(state.url);
        setBrowserUrl(state.url);
      }
    });
    return () => window.electronAPI?.removeAllListeners("browser:state");
  }, [isNativeBrowser, setBrowserUrl]);

  const syncNativeBounds = useCallback(() => {
    if (!isNativeBrowser || !window.electronAPI || viewMode !== "browser") return;
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    void window.electronAPI.invoke("browser:setBounds", {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });
  }, [isNativeBrowser, viewMode]);

  useEffect(() => {
    if (!isNativeBrowser || viewMode !== "browser") return;
    syncNativeBounds();
    const observer = new ResizeObserver(syncNativeBounds);
    if (contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("resize", syncNativeBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncNativeBounds);
    };
  }, [isNativeBrowser, syncNativeBounds, viewMode]);

  useEffect(() => {
    if (!isNativeBrowser || !window.electronAPI) return;
    if (viewMode !== "browser") {
      void window.electronAPI.invoke("browser:hide");
      return;
    }
    if (!src) {
      void window.electronAPI.invoke("browser:hide");
      return;
    }
    syncNativeBounds();
    void window.electronAPI.invoke("browser:open", src);
  }, [isNativeBrowser, src, syncNativeBounds, viewMode]);

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    setSrc(url);
    setBrowserUrl(url);
    setInput(url);
    setLoadFailed(false);
    loadedRef.current = false;
    setLoadKey((k) => k + 1);
  };

  // Many sites send X-Frame-Options/CSP that block embedding. The iframe's
  // onLoad won't fire (or fires with an empty doc) when that happens — detect
  // the "never loaded" case after a grace period and surface a fallback.
  useEffect(() => {
    if (!src || isNativeBrowser) return;
    setLoadFailed(false);
    const timer = setTimeout(() => {
      if (!loadedRef.current) setLoadFailed(true);
    }, 4000);
    return () => clearTimeout(timer);
  }, [src, loadKey, isNativeBrowser]);

  if (viewMode !== "browser") return null;

  const reload = () => {
    if (isNativeBrowser) {
      void window.electronAPI?.invoke("browser:reload");
      return;
    }
    loadedRef.current = false;
    setLoadFailed(false);
    setLoadKey((k) => k + 1);
  };

  const goBack = () => {
    if (isNativeBrowser) {
      void window.electronAPI?.invoke("browser:back");
      return;
    }
    iframeRef.current?.contentWindow?.history.back();
  };

  const goForward = () => {
    if (isNativeBrowser) {
      void window.electronAPI?.invoke("browser:forward");
      return;
    }
    iframeRef.current?.contentWindow?.history.forward();
  };

  const openExternal = () => {
    if (!src) return;
    window.open(src, "_blank", "noopener,noreferrer");
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 z-30 bg-canvas flex flex-col"
    >
      {/* Top bar */}
      <div className="flex-shrink-0 h-10 px-3 flex items-center gap-2 bg-canvas-dark border-b border-border">
        <button
          onClick={goBack}
          className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors disabled:opacity-40"
          disabled={isNativeBrowser ? !nativeState.canGoBack : !src}
          title="Back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={goForward}
          className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors disabled:opacity-40"
          disabled={isNativeBrowser ? !nativeState.canGoForward : !src}
          title="Forward"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={reload}
          className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors disabled:opacity-40"
          disabled={!src}
          title="Reload"
        >
          {isNativeBrowser && nativeState.loading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCw className="w-3.5 h-3.5" />
          )}
        </button>

        <div className="flex-1 flex items-center gap-2 px-2.5 py-1 rounded-md bg-canvas border border-border">
          <Globe className="w-3.5 h-3.5 text-zinc-600 flex-shrink-0" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(input);
            }}
            placeholder="localhost:3000 or https://…"
            className="flex-1 bg-transparent text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>

        {src && (
          <button
            onClick={openExternal}
            className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
            title="Open in external browser"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}

        <button
          onClick={() => setViewMode("canvas")}
          className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] text-zinc-400 hover:text-white hover:bg-surface-active transition-colors"
          title="Exit browser (Escape)"
        >
          <Minimize2 className="w-3 h-3" />
          Canvas
        </button>
      </div>

      {/* Content */}
      <div
        ref={contentRef}
        className={`flex-1 min-h-0 relative ${isNativeBrowser ? "bg-canvas" : "bg-white"}`}
      >
        {!src && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500 bg-canvas">
            <Globe className="w-8 h-8 opacity-40" />
            <div className="text-sm">Enter a URL to preview</div>
            <div className="text-xs text-zinc-600">
              Tip: type a local dev server like{" "}
              <span className="font-mono text-zinc-400">localhost:5173</span>
            </div>
          </div>
        )}

        {src && isNativeBrowser && (
          <div className="absolute inset-0 bg-canvas">
            {nativeState.loading && (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded bg-canvas-dark/95 border border-border px-2 py-1 text-[11px] text-zinc-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading
              </div>
            )}
          </div>
        )}

        {src && !isNativeBrowser && (
          <iframe
            key={loadKey}
            ref={iframeRef}
            src={src}
            title="Web preview"
            className="w-full h-full border-0"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
            onLoad={() => {
              loadedRef.current = true;
              setLoadFailed(false);
            }}
          />
        )}

        {src && !isNativeBrowser && loadFailed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-400 bg-canvas">
            <Globe className="w-8 h-8 opacity-40" />
            <div className="text-sm">This site can't be embedded</div>
            <div className="text-xs text-zinc-600 max-w-sm text-center">
              It likely sends <span className="font-mono">X-Frame-Options</span> or a
              frame-blocking CSP. Local dev servers and most apps still work.
            </div>
            <a
              href={src}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface border border-border text-xs text-zinc-200 hover:bg-surface-active transition-colors"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open in external browser
            </a>
          </div>
        )}
      </div>
    </motion.div>
  );
}
