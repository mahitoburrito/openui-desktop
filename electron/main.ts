import { app, BrowserWindow, shell, dialog } from "electron";
import { join } from "path";
import { startServer } from "../server/index";
import { autoUpdater } from "electron-updater";
import { initPRBE, cleanupPRBE } from "./prbe";

let mainWindow: BrowserWindow | null = null;
let serverPort = Number(process.env.PORT) || 6968;
const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "OpenUI Desktop",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  if (isDev) {
    // In dev mode, load from Vite dev server
    mainWindow.loadURL(`http://localhost:5173`);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    // In production, load from the embedded server
    mainWindow.loadURL(`http://localhost:${serverPort}`);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  // Set the launch CWD to the user's home directory by default
  process.env.LAUNCH_CWD = process.env.LAUNCH_CWD || app.getPath("home");

  // Start the embedded server
  try {
    serverPort = await startServer();
    console.log(`[electron] Server started on port ${serverPort}`);
  } catch (err) {
    console.error("[electron] Failed to start server:", err);
    dialog.showErrorBox(
      "Server Error",
      "Failed to start the embedded server. The application may not work correctly."
    );
  }

  createWindow();

  // Initialize PRBE debug agent
  initPRBE(mainWindow!, serverPort);

  // Auto-update (only in packaged builds)
  if (!isDev) {
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
      console.log(`[updater] Update available: v${info.version}`);
    });

    autoUpdater.on("update-downloaded", (info) => {
      const response = dialog.showMessageBoxSync(mainWindow!, {
        type: "info",
        title: "Update Ready",
        message: `OpenUI v${info.version} has been downloaded.`,
        detail: "Restart now to apply the update?",
        buttons: ["Restart", "Later"],
        defaultId: 0,
      });
      if (response === 0) {
        autoUpdater.quitAndInstall();
      }
    });

    autoUpdater.on("error", (err) => {
      console.error("[updater] Error:", err.message);
    });

    autoUpdater.checkForUpdates().catch((err) => {
      console.error("[updater] Check failed:", err.message);
    });
  }

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed (except on macOS)
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Cleanup before quit
app.on("before-quit", () => {
  cleanupPRBE();
  // Server cleanup is handled by its own SIGINT handler
  process.emit("SIGINT" as any);
});
