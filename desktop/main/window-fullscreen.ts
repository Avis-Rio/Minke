import type { BrowserWindow } from "electron";
import { WINDOW_FULLSCREEN_CHANNEL } from "@minke/desktop/window-fullscreen-contract.ts";

/** Keep DSH's titlebar clearance in sync with the native window, including reloads. */
export function bindWindowFullscreen(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== "darwin" && platform !== "win32") return () => {};
  const contents = window.webContents;
  let disposed = false;
  const publish = (): void => {
    if (disposed || window.isDestroyed() || contents.isDestroyed()) return;
    contents.send(WINDOW_FULLSCREEN_CHANNEL, window.isFullScreen());
  };
  window.on("enter-full-screen", publish);
  window.on("leave-full-screen", publish);
  contents.on("did-finish-load", publish);
  return () => {
    if (disposed) return;
    disposed = true;
    window.off("enter-full-screen", publish);
    window.off("leave-full-screen", publish);
    contents.off("did-finish-load", publish);
  };
}
