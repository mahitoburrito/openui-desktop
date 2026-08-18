import { BrowserWindow, WebContentsView, ipcMain, shell } from "electron";
import { isExternalAuthUrl, normalizeBrowserUrl } from "./browserPolicy";

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
let lastExternalUrl = "";
let lastExternalAt = 0;

const CHANNELS = [
  "browser:open",
  "browser:setBounds",
  "browser:navigate",
  "browser:reload",
  "browser:back",
  "browser:forward",
  "browser:hide",
  "browser:close",
  "browser:openExternal",
];

async function openExternalAuth(url: string) {
  view?.setVisible(false);
  host?.webContents.send("browser:external-opened", { url, reason: "oauth" });

  const now = Date.now();
  if (url === lastExternalUrl && now - lastExternalAt < 1500) return;
  lastExternalUrl = url;
  lastExternalAt = now;
  await shell.openExternal(url).catch(() => undefined);
}

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
  wc.on("did-navigate", emitState);
  wc.on("did-navigate-in-page", emitState);
  wc.on("did-start-loading", emitState);
  wc.on("did-stop-loading", emitState);
  wc.on("page-title-updated", emitState);
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.key !== "Escape" || input.isAutoRepeat) return;
    event.preventDefault();
    view?.setVisible(false);
    host?.webContents.send("browser:close-requested");
    host?.webContents.focus();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (isExternalAuthUrl(url)) {
      void openExternalAuth(url);
      return { action: "deny" };
    }
    wc.loadURL(url).catch(() => shell.openExternal(url));
    return { action: "deny" };
  });
  const guardAuthNavigation = (event: Electron.Event, url: string) => {
    if (!isExternalAuthUrl(url)) return;
    event.preventDefault();
    void openExternalAuth(url);
  };
  wc.on("will-navigate", guardAuthNavigation);
  wc.on("will-redirect", guardAuthNavigation);

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

  ipcMain.handle("browser:open", async (_event, url: string) => {
    const target = normalizeBrowserUrl(url || currentUrl);
    if (!target) return { ok: false };
    if (isExternalAuthUrl(target)) {
      await openExternalAuth(target);
      return { ok: true, external: true };
    }
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

  ipcMain.handle("browser:navigate", async (_event, url: string) => {
    const target = normalizeBrowserUrl(url);
    if (!target) return { ok: false };
    if (isExternalAuthUrl(target)) {
      await openExternalAuth(target);
      return { ok: true, external: true };
    }
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

  ipcMain.handle("browser:openExternal", async (_event, url: string) => {
    const target = normalizeBrowserUrl(url);
    if (!target) return { ok: false };
    await shell.openExternal(target);
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
  lastExternalUrl = "";
  lastExternalAt = 0;
}
