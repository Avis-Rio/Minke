import type { IpcRenderer } from "electron";
import { DESKTOP_UPDATE_IPC, type DesktopUpdateBridge, type DesktopUpdatePresentation } from "@minke/harness-overlay/shared-updates-contract.ts";

/** The main process owns update decisions; the renderer only observes and opens its dialog. */
export function createDesktopUpdatesBridge(ipc: Pick<IpcRenderer, "on" | "off" | "invoke">): {
  updates: DesktopUpdateBridge;
  dispose(): void;
} {
  const listeners = new Set<(state: DesktopUpdatePresentation) => void>();
  const changed = (_event: unknown, state: DesktopUpdatePresentation): void => {
    for (const listener of [...listeners]) {
      try { listener(state); }
      catch (error) { console.error("Desktop update observer failed", error); }
    }
  };
  ipc.on(DESKTOP_UPDATE_IPC.changed, changed);
  return {
    updates: Object.freeze<DesktopUpdateBridge>({
      status: () => ipc.invoke(DESKTOP_UPDATE_IPC.status),
      open: () => ipc.invoke(DESKTOP_UPDATE_IPC.open),
      subscribe(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    }),
    dispose() {
      ipc.off(DESKTOP_UPDATE_IPC.changed, changed);
      listeners.clear();
    },
  };
}
