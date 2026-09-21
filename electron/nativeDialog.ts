import { BrowserWindow, dialog, ipcMain } from "electron";

const OPEN_DIRECTORY_CHANNEL = "dialog:open-directory";

export function registerNativeDialogIpc(getWindow: () => BrowserWindow | null) {
  ipcMain.removeHandler(OPEN_DIRECTORY_CHANNEL);
  ipcMain.handle(
    OPEN_DIRECTORY_CHANNEL,
    async (_event, defaultPath?: unknown): Promise<string | null> => {
      const window = getWindow();
      const options: Electron.OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
        defaultPath: typeof defaultPath === "string" && defaultPath ? defaultPath : undefined,
      };

      // Sheet-attached when we have a window so the dialog is modal to the app
      // rather than a free-floating panel behind it.
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);

      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    }
  );
}

export function destroyNativeDialogIpc() {
  ipcMain.removeHandler(OPEN_DIRECTORY_CHANNEL);
}
