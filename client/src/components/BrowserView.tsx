import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { Codicon } from "./Codicon";

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

// The native WebContentsView paints above ALL renderer DOM, so a resize
// handle drawn at the panel's left edge would be unreachable below the top
// bar. Inset the native view by this many px to leave a grabbable rail
// along the full divider height.
const RESIZE_GUTTER = 8;

interface NativeBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

export function BrowserView() {
  const {
    browserUrl,
    setBrowserUrl,
    browserPanelOpen,
    setBrowserPanelOpen,
    browserPanelWidth,
    setBrowserPanelWidth,
    browserAutoOpened,
    setBrowserAutoOpened,
  } = useStore();

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
  const panelRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const syncFrameRef = useRef<number | null>(null);
  const autoFitAppliedRef = useRef(false);
  const dragWidthRef = useRef(browserPanelWidth);
  const dragFrameRef = useRef<number | null>(null);

  const clampPanelWidth = useCallback(
    (width: number) => {
      const minWidth = 360;
      const maxWidth = Math.max(minWidth, Math.min(1100, window.innerWidth - 360));
      return Math.min(maxWidth, Math.max(minWidth, Math.round(width)));
    },
    [],
  );

  const preferredPanelWidth = useCallback(() => {
    return clampPanelWidth(Math.max(720, window.innerWidth * 0.58));
  }, [clampPanelWidth]);

  useEffect(() => {
    return () => {
      if (syncFrameRef.current !== null) {
        cancelAnimationFrame(syncFrameRef.current);
      }
      if (dragFrameRef.current !== null) {
        cancelAnimationFrame(dragFrameRef.current);
      }
      if (isNativeBrowser && window.electronAPI) {
        void window.electronAPI.invoke("browser:hide");
      }
    };
  }, [isNativeBrowser]);

  useEffect(() => {
    setInput(browserUrl);

    const nextSrc = browserUrl ? normalizeUrl(browserUrl) : "";
    if (!nextSrc || nextSrc === src) return;
    if (isNativeBrowser && nativeState.url && normalizeUrl(nativeState.url) === nextSrc) return;

    setSrc(nextSrc);
    setLoadFailed(false);
    loadedRef.current = false;
    setLoadKey((k) => k + 1);
  }, [browserUrl, isNativeBrowser, nativeState.url, src]);

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

  // Bounds come from the live content rect, which reflects both the drag
  // width (set imperatively during resize) and the entrance animation's
  // transform — so the native view tracks the panel instead of popping to
  // its final position after the slide finishes.
  const syncNativeBounds = useCallback(() => {
    if (!isNativeBrowser || !window.electronAPI || !browserPanelOpen) return;
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;

    const x = Math.max(0, Math.round(rect.left) + RESIZE_GUTTER);
    const y = Math.max(0, rect.top);
    const width = Math.max(1, window.innerWidth - x);
    const height = Math.max(1, Math.min(rect.height, window.innerHeight - y));

    void window.electronAPI.invoke("browser:setBounds", {
      x,
      y,
      width,
      height,
    });
  }, [browserPanelOpen, isNativeBrowser]);

  const syncNativeBoundsFor = useCallback(
    (_panelWidth: number) => {
      syncNativeBounds();
    },
    [syncNativeBounds],
  );

  const scheduleNativeBoundsSync = useCallback(() => {
    if (!isNativeBrowser || !browserPanelOpen) return;
    if (syncFrameRef.current !== null) {
      cancelAnimationFrame(syncFrameRef.current);
    }
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = requestAnimationFrame(() => {
        syncFrameRef.current = null;
        syncNativeBounds();
      });
    });
  }, [browserPanelOpen, isNativeBrowser, syncNativeBounds]);

  useEffect(() => {
    if (!isNativeBrowser || !browserPanelOpen) return;
    scheduleNativeBoundsSync();
    const observer = new ResizeObserver(scheduleNativeBoundsSync);
    if (contentRef.current) observer.observe(contentRef.current);
    window.addEventListener("resize", scheduleNativeBoundsSync);
    window.visualViewport?.addEventListener("resize", scheduleNativeBoundsSync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleNativeBoundsSync);
      window.visualViewport?.removeEventListener("resize", scheduleNativeBoundsSync);
    };
  }, [browserPanelOpen, isNativeBrowser, scheduleNativeBoundsSync]);

  useEffect(() => {
    if (!isNativeBrowser || !window.electronAPI) return;
    if (!browserPanelOpen) {
      void window.electronAPI.invoke("browser:hide");
      return;
    }
    if (!src) {
      void window.electronAPI.invoke("browser:hide");
      return;
    }
    scheduleNativeBoundsSync();
    void window.electronAPI.invoke("browser:open", src);
  }, [browserPanelOpen, isNativeBrowser, scheduleNativeBoundsSync, src]);

  useEffect(() => {
    if (!browserPanelOpen) {
      autoFitAppliedRef.current = false;
      return;
    }
    if (autoFitAppliedRef.current) return;
    autoFitAppliedRef.current = true;
    setBrowserPanelWidth(clampPanelWidth(Math.max(browserPanelWidth, preferredPanelWidth())));
    scheduleNativeBoundsSync();
  }, [
    browserPanelOpen,
    browserPanelWidth,
    clampPanelWidth,
    preferredPanelWidth,
    scheduleNativeBoundsSync,
    setBrowserPanelWidth,
  ]);

  useEffect(() => {
    if (!browserPanelOpen) return;
    let frame: number | null = null;
    const handleResize = () => {
      // rAF-throttled: window resize fires per frame and the store write
      // re-renders the whole app; once per frame is plenty.
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        setBrowserPanelWidth(clampPanelWidth(browserPanelWidth));
        scheduleNativeBoundsSync();
      });
    };
    window.addEventListener("resize", handleResize);
    handleResize();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, [
    browserPanelOpen,
    browserPanelWidth,
    clampPanelWidth,
    scheduleNativeBoundsSync,
    setBrowserPanelWidth,
  ]);

  const beginResize = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = browserPanelWidth;
      dragWidthRef.current = startWidth;

      const handleMove = (moveEvent: MouseEvent) => {
        const next = clampPanelWidth(startWidth + startX - moveEvent.clientX);
        dragWidthRef.current = next;
        // Imperative width during the drag: writing the store on every
        // mousemove re-renders the whole app (all mounted terminals) per
        // frame and stutters. The store gets one commit on mouseup.
        if (panelRef.current) {
          panelRef.current.style.width = `${next}px`;
        }
        if (dragFrameRef.current === null) {
          dragFrameRef.current = requestAnimationFrame(() => {
            dragFrameRef.current = null;
            syncNativeBoundsFor(dragWidthRef.current);
          });
        }
      };

      const handleUp = () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        // Single state commit + final settle at the exact drop position.
        setBrowserPanelWidth(dragWidthRef.current);
        syncNativeBoundsFor(dragWidthRef.current);
      };

      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [browserPanelWidth, clampPanelWidth, setBrowserPanelWidth, syncNativeBoundsFor],
  );

  const navigate = (raw: string) => {
    const url = normalizeUrl(raw);
    if (!url) return;
    setBrowserAutoOpened(false);
    setSrc(url);
    setBrowserUrl(url);
    setInput(url);
    setLoadFailed(false);
    loadedRef.current = false;
    setLoadKey((k) => k + 1);
    setBrowserPanelOpen(true);
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

  if (!browserPanelOpen) return null;

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
      ref={panelRef}
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      // Short tween instead of a spring: the native WebContentsView follows
      // via onUpdate, and a spring's overshoot makes it visibly rubber-band.
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="absolute right-0 top-0 bottom-0 z-30 bg-canvas-dark border-l border-border flex flex-col shadow-2xl"
      style={{ width: browserPanelWidth }}
      onUpdate={syncNativeBounds}
      onAnimationComplete={scheduleNativeBoundsSync}
    >
      {/* Full-height resize rail. The native view is inset by RESIZE_GUTTER,
          so this strip stays clickable from top bar to bottom edge. */}
      <div
        onMouseDown={beginResize}
        title="Drag to resize"
        className="group absolute left-0 top-0 bottom-0 z-20 w-2 cursor-col-resize hover:bg-blue-500/30 active:bg-blue-500/50 transition-colors"
      >
        <div className="absolute left-[3px] top-1/2 -translate-y-1/2 h-12 w-[2px] rounded-full bg-zinc-700 group-hover:bg-blue-400 transition-colors" />
      </div>

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

        {browserAutoOpened && (
          <span
            className="flex flex-shrink-0 items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 text-[9px] font-semibold text-accent"
            title="Opened automatically from the agent's output"
          >
            <Codicon name="sparkle" size={10} />
            Auto
          </span>
        )}

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
          onClick={() => {
            setBrowserAutoOpened(false);
            setBrowserPanelOpen(false);
          }}
          className="w-7 h-7 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-surface-active transition-colors"
          title="Close browser dock (Escape)"
        >
          <Minimize2 className="w-3.5 h-3.5" />
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
