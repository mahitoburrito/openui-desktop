import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { motion } from "framer-motion";
import { useStore } from "../stores/useStore";
import { Codicon } from "./Codicon";
import { MicroButton } from "./micro";
import { isGoogleAuthUrl } from "../utils/webLinks";

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
const BROWSER_HISTORY_KEY = "openui.browser.history.v1";

interface BrowserHistoryEntry {
  url: string;
  title: string;
  visitedAt: number;
}

function loadBrowserHistory(): BrowserHistoryEntry[] {
  try {
    const value = JSON.parse(localStorage.getItem(BROWSER_HISTORY_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item.url === "string" && /^https?:\/\//i.test(item.url))
      .slice(0, 30);
  } catch {
    return [];
  }
}

interface NativeBrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

interface ExternalBrowserHandoff {
  url: string;
  reason: "oauth";
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
    openBrowserUrl,
  } = useStore();

  const isNativeBrowser = Boolean(window.electronAPI?.isElectron);
  const [input, setInput] = useState(browserUrl);
  // The URL actually loaded in the iframe (committed on submit/reload).
  const [src, setSrc] = useState(browserUrl ? normalizeUrl(browserUrl) : "");
  const [loadKey, setLoadKey] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [browserHistory, setBrowserHistory] = useState<BrowserHistoryEntry[]>(loadBrowserHistory);
  const [addressFocused, setAddressFocused] = useState(false);
  const [externalHandoff, setExternalHandoff] = useState<ExternalBrowserHandoff | null>(() =>
    browserPanelOpen && isGoogleAuthUrl(browserUrl)
      ? { url: normalizeUrl(browserUrl), reason: "oauth" }
      : null,
  );
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

  const rememberVisit = useCallback((url: string, title = "") => {
    if (!/^https?:\/\//i.test(url)) return;
    setBrowserHistory((current) => {
      const previous = current.find((entry) => entry.url === url);
      const next = [
        {
          url,
          title: title.trim() || previous?.title || "",
          visitedAt: Date.now(),
        },
        ...current.filter((entry) => entry.url !== url),
      ].slice(0, 30);
      try {
        localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(next));
      } catch {
        // Browsing still works when local storage is unavailable.
      }
      return next;
    });
  }, []);

  const browserSuggestions = useMemo(() => {
    const query = input.trim().toLowerCase();
    const matches = query
      ? browserHistory.filter((entry) =>
          entry.url.toLowerCase().includes(query) || entry.title.toLowerCase().includes(query),
        )
      : browserHistory;
    return matches.slice(0, 8);
  }, [browserHistory, input]);

  const navigate = useCallback(
    (raw: string) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      setExternalHandoff(null);
      setSrc(url);
      setInput(url);
      setLoadFailed(false);
      loadedRef.current = false;
      setLoadKey((k) => k + 1);
      openBrowserUrl(url, "manual");
      rememberVisit(url);
    },
    [openBrowserUrl, rememberVisit],
  );

  const closeBrowser = useCallback(() => {
    setBrowserAutoOpened(false);
    setBrowserPanelOpen(false);
  }, [setBrowserAutoOpened, setBrowserPanelOpen]);

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

    if (externalHandoff && externalHandoff.url !== nextSrc) setExternalHandoff(null);
    setSrc(nextSrc);
    setLoadFailed(false);
    loadedRef.current = false;
    setLoadKey((k) => k + 1);
  }, [browserUrl, externalHandoff, isNativeBrowser, nativeState.url, src]);

  useEffect(() => {
    if (!isNativeBrowser || !window.electronAPI) return;
    window.electronAPI.on("browser:state", (state: NativeBrowserState) => {
      setNativeState(state);
      if (state.url) {
        setExternalHandoff(null);
        setInput(state.url);
        setBrowserUrl(state.url);
        rememberVisit(state.url, state.title);
      }
    });
    return () => window.electronAPI?.removeAllListeners("browser:state");
  }, [isNativeBrowser, rememberVisit, setBrowserUrl]);

  useEffect(() => {
    if (!isNativeBrowser || !window.electronAPI) return;
    window.electronAPI.on("browser:open-requested", (url: string) => navigate(url));
    window.electronAPI.on("browser:close-requested", closeBrowser);
    window.electronAPI.on("browser:external-opened", (handoff: ExternalBrowserHandoff) => {
      if (!handoff?.url) return;
      setExternalHandoff(handoff);
      setSrc(handoff.url);
      setInput(handoff.url);
      setBrowserUrl(handoff.url);
    });
    return () => {
      window.electronAPI?.removeAllListeners("browser:open-requested");
      window.electronAPI?.removeAllListeners("browser:close-requested");
      window.electronAPI?.removeAllListeners("browser:external-opened");
    };
  }, [closeBrowser, isNativeBrowser, navigate]);

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
    if (externalHandoff?.url === src) {
      void window.electronAPI.invoke("browser:hide");
      return;
    }
    scheduleNativeBoundsSync();
    void window.electronAPI.invoke("browser:open", src).then((result) => {
      if (result?.external) setExternalHandoff({ url: src, reason: "oauth" });
    });
  }, [browserPanelOpen, externalHandoff?.url, isNativeBrowser, scheduleNativeBoundsSync, src]);

  useEffect(() => {
    scheduleNativeBoundsSync();
  }, [addressFocused, browserSuggestions.length, scheduleNativeBoundsSync]);

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
    if (externalHandoff) {
      void window.electronAPI?.invoke("browser:openExternal", externalHandoff.url);
      return;
    }
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
    const target = externalHandoff?.url || src;
    if (!target) return;
    if (isNativeBrowser && window.electronAPI) {
      void window.electronAPI.invoke("browser:openExternal", target);
      return;
    }
    window.open(target, "_blank", "noopener,noreferrer");
  };

  const showBrowserSuggestions = addressFocused && browserSuggestions.length > 0;

  return (
    <motion.div
      ref={panelRef}
      initial={{ x: "100%", opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: "100%", opacity: 0 }}
      // Short tween instead of a spring: the native WebContentsView follows
      // via onUpdate, and a spring's overshoot makes it visibly rubber-band.
      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
      className="absolute bottom-0 right-0 top-0 z-30 flex flex-col overflow-hidden border-l border-white/[0.075] bg-[oklch(0.125_0.007_255)] shadow-[-18px_0_48px_oklch(0.03_0.005_255/.24)]"
      style={{ width: browserPanelWidth }}
      onUpdate={syncNativeBounds}
      onAnimationComplete={scheduleNativeBoundsSync}
    >
      {/* Full-height resize rail. The native view is inset by RESIZE_GUTTER,
          so this strip stays clickable from top bar to bottom edge. */}
      <div
        onMouseDown={beginResize}
        title="Drag to resize"
        className="group absolute bottom-0 left-0 top-0 z-20 w-2 cursor-col-resize transition-colors hover:bg-white/[0.045] active:bg-white/[0.075]"
      >
        <div className="absolute left-[3px] top-1/2 h-12 w-[2px] -translate-y-1/2 rounded-full bg-zinc-700 transition-colors group-hover:bg-zinc-400" />
      </div>

      {/* Top bar */}
      <div className="relative z-30 flex h-12 min-w-0 flex-shrink-0 items-center gap-1.5 border-b border-white/[0.065] bg-[oklch(0.145_0.008_255)] px-2.5">
        <MicroButton
          interaction="nudge-left"
          onClick={goBack}
          className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-white disabled:opacity-40"
          disabled={isNativeBrowser ? !nativeState.canGoBack : !src}
          title="Back"
        >
          <Codicon name="arrow-left" size={14} />
        </MicroButton>
        <MicroButton
          interaction="nudge-right"
          onClick={goForward}
          className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-white disabled:opacity-40"
          disabled={isNativeBrowser ? !nativeState.canGoForward : !src}
          title="Forward"
        >
          <Codicon name="arrow-right" size={14} />
        </MicroButton>
        <MicroButton
          interaction="rotate"
          onClick={reload}
          className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-white disabled:opacity-40"
          disabled={!src}
          title="Reload"
        >
          {isNativeBrowser && nativeState.loading ? (
            <Codicon name="loading" size={14} className="codicon-modifier-spin" />
          ) : (
            <Codicon name="refresh" size={14} />
          )}
        </MicroButton>

        {browserAutoOpened && (
          <span
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-accent-soft text-accent"
            title="Opened automatically from the agent's output"
            aria-label="Opened automatically from the agent's output"
          >
            <Codicon name="sparkle" size={10} />
          </span>
        )}

        <div className="workspace-glass-segment flex min-w-0 flex-1 items-center gap-2 rounded-[7px] px-2.5 py-1">
          <Codicon name="globe" size={13} className="flex-shrink-0 text-zinc-600" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={() => setAddressFocused(true)}
            onBlur={() => window.setTimeout(() => setAddressFocused(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(input);
              if (e.key === "Escape") setAddressFocused(false);
            }}
            placeholder="localhost:3000 or https://…"
            className="min-w-0 w-full truncate bg-transparent text-xs font-mono text-zinc-200 placeholder-zinc-600 focus:outline-none"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={showBrowserSuggestions}
            aria-controls="openui-browser-suggestions"
          />
        </div>

        {src && (
          <MicroButton
            interaction="nudge-right"
            onClick={openExternal}
            className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-white"
            title="Open in external browser"
          >
            <Codicon name="link-external" size={14} />
          </MicroButton>
        )}

        <MicroButton
          interaction="none"
          onClick={closeBrowser}
          className="workspace-icon-button flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:text-white"
          title="Close browser dock (Escape)"
        >
          <Codicon name="close" size={14} />
        </MicroButton>
      </div>

      {showBrowserSuggestions && (
        <div
          id="openui-browser-suggestions"
          role="listbox"
          className="relative z-30 max-h-44 flex-shrink-0 overflow-y-auto border-b border-white/[0.065] bg-[oklch(0.135_0.007_255)] px-2 py-1.5"
          onPointerDown={(event) => event.preventDefault()}
        >
          {browserSuggestions.slice(0, 5).map((entry) => (
            <button
              key={entry.url}
              type="button"
              role="option"
              onClick={() => {
                navigate(entry.url);
                setAddressFocused(false);
              }}
              className="flex w-full min-w-0 items-center gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors hover:bg-white/[0.045] focus-visible:bg-white/[0.055] focus-visible:outline-none"
              title={entry.url}
            >
              <Codicon name="history" size={12} className="flex-shrink-0 text-zinc-600" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] text-zinc-300">
                  {entry.title || entry.url}
                </span>
                {entry.title && (
                  <span className="block truncate font-mono text-[9px] text-zinc-600">
                    {entry.url}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div
        ref={contentRef}
        className={`flex-1 min-h-0 relative ${isNativeBrowser ? "bg-canvas" : "bg-white"}`}
      >
        {!src && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-zinc-500 bg-canvas">
            <Codicon name="globe" size={30} className="opacity-40" />
            <div className="text-sm">Enter a URL to preview</div>
            <div className="text-xs text-zinc-600">
              Tip: type a local dev server like{" "}
              <span className="font-mono text-zinc-400">localhost:5173</span>
            </div>
          </div>
        )}

        {src && isNativeBrowser && externalHandoff && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas px-8 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-white/[0.07] bg-white/[0.035] text-zinc-400">
              <Codicon name="link-external" size={18} />
            </span>
            <strong className="mt-4 text-[13px] font-medium text-zinc-200">
              Google sign-in opened in your browser
            </strong>
            <p className="mt-1 max-w-sm text-[11px] leading-5 text-zinc-600">
              Google blocks sign-in inside embedded app browsers. Finish there, then return to OpenUI.
            </p>
            <button
              type="button"
              onClick={openExternal}
              className="mt-4 rounded-[7px] border border-white/[0.075] bg-white/[0.04] px-3 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-white/[0.07]"
            >
              Open again
            </button>
          </div>
        )}

        {src && isNativeBrowser && !externalHandoff && (
          <div className="absolute inset-0 bg-canvas">
            {nativeState.loading && (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded bg-canvas-dark/95 border border-border px-2 py-1 text-[11px] text-zinc-500">
              <Codicon name="loading" size={12} className="codicon-modifier-spin" />
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
            <Codicon name="globe" size={30} className="opacity-40" />
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
              <Codicon name="link-external" size={14} />
              Open in external browser
            </a>
          </div>
        )}
      </div>
    </motion.div>
  );
}
