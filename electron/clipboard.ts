import { clipboard, ipcMain } from "electron";

const READ_IMAGE_CHANNEL = "clipboard:read-image";
const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

export interface NativeClipboardImage {
  mimeType: "image/png";
  base64: string;
  byteLength: number;
}

export function registerClipboardIpc() {
  ipcMain.removeHandler(READ_IMAGE_CHANNEL);
  ipcMain.handle(READ_IMAGE_CHANNEL, (): NativeClipboardImage | null => {
    const image = clipboard.readImage("clipboard");
    if (image.isEmpty()) return null;

    const png = image.toPNG();
    if (png.byteLength === 0) return null;
    if (png.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) {
      throw new Error(`Clipboard image exceeds ${MAX_CLIPBOARD_IMAGE_BYTES / 1024 / 1024}MB`);
    }

    return {
      mimeType: "image/png",
      base64: png.toString("base64"),
      byteLength: png.byteLength,
    };
  });
}

export function destroyClipboardIpc() {
  ipcMain.removeHandler(READ_IMAGE_CHANNEL);
}
