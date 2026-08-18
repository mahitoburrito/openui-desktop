import { BrowserWindow, WebContentsView, ipcMain, shell } from "electron";
import { normalizeWebNavigationInput, safeWebNavigationUrl } from "./externalNavigation";

interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

let view: WebContentsView | null = null;
let host: BrowserWindow | null = null;
let lastBounds: BrowserBounds | null = null;
let currentUrl = "";

const CHANNELS = [
  "browser:open",
  "browser:setBounds",
  "browser:navigate",
  "browser:reload",
  "browser:back",
  "browser:forward",
  "browser:hide",
  "browser:close",
];

function emitState() {
  if (!host || host.isDestroyed() || !view) return;
  const wc = view.webContents;
  host.webContents.send("browser:state", {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  });
}

function ensureView(): WebContentsView {
  if (view) return view;

  view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (host) host.contentView.addChildView(view);
  const wc = view.webContents;
  wc.on("did-navigate", (_event, url) => {
    currentUrl = safeWebNavigationUrl(url) || "";
    emitState();
  });
  wc.on("did-navigate-in-page", emitState);
  wc.on("did-start-loading", emitState);
  wc.on("did-stop-loading", emitState);
  wc.on("page-title-updated", emitState);
  const preventUnsafeNavigation = (event: { preventDefault(): void }, url: string) => {
    if (!safeWebNavigationUrl(url)) event.preventDefault();
  };
  wc.on("will-navigate", preventUnsafeNavigation);
  wc.on("will-redirect", preventUnsafeNavigation);
  wc.setWindowOpenHandler(({ url }) => {
    const target = safeWebNavigationUrl(url);
    if (target) {
      currentUrl = target;
      void wc.loadURL(target).catch(() => shell.openExternal(target).catch(() => undefined));
    }
    return { action: "deny" };
  });

  return view;
}

function applyBounds() {
  if (!view || !lastBounds) return;
  // The renderer measures in CSS pixels, but setBounds takes DIPs. These
  // diverge whenever the window is zoomed (Cmd +/- via the default View
  // menu), leaving the native view offset and clipped at the window edge.
  const zoom = host && !host.isDestroyed() ? host.webContents.getZoomFactor() : 1;
  view.setBounds({
    x: Math.max(0, Math.round(lastBounds.x * zoom)),
    y: Math.max(0, Math.round(lastBounds.y * zoom)),
    width: Math.max(1, Math.round(lastBounds.width * zoom)),
    height: Math.max(1, Math.round(lastBounds.height * zoom)),
  });
}

function removeExistingHandlers() {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
  }
}

export function registerBrowserViewIpc(window: BrowserWindow) {
  host = window;
  removeExistingHandlers();

  ipcMain.handle("browser:open", async (_event, url: unknown) => {
    const target = normalizeWebNavigationInput(url);
    if (!target) return { ok: false };
    const browserView = ensureView();
    browserView.setVisible(true);
    applyBounds();
    if (target !== currentUrl || browserView.webContents.getURL() !== target) {
      currentUrl = target;
      await browserView.webContents.loadURL(target).catch(() => undefined);
    }
    emitState();
    return { ok: true };
  });

  ipcMain.handle("browser:setBounds", (_event, bounds: BrowserBounds) => {
    lastBounds = bounds;
    applyBounds();
    return { ok: true };
  });

  ipcMain.handle("browser:navigate", async (_event, url: unknown) => {
    const target = normalizeWebNavigationInput(url);
    if (!target) return { ok: false };
    const browserView = ensureView();
    browserView.setVisible(true);
    currentUrl = target;
    await browserView.webContents.loadURL(target).catch(() => undefined);
    emitState();
    return { ok: true };
  });

  ipcMain.handle("browser:reload", () => {
    view?.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle("browser:back", () => {
    if (view?.webContents.navigationHistory.canGoBack()) {
      view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  });

  ipcMain.handle("browser:forward", () => {
    if (view?.webContents.navigationHistory.canGoForward()) {
      view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  });

  ipcMain.handle("browser:hide", () => {
    view?.setVisible(false);
    return { ok: true };
  });

  ipcMain.handle("browser:close", () => {
    destroyBrowserView();
    return { ok: true };
  });
}

export function destroyBrowserView() {
  if (view && host && !host.isDestroyed()) {
    try {
      host.contentView.removeChildView(view);
      view.webContents.close();
    } catch {
      // Window is already tearing down.
    }
  }
  view = null;
  lastBounds = null;
  currentUrl = "";
}
