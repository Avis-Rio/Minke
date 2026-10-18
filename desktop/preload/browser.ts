import type { IpcRenderer } from "electron";
import {
  DESKTOP_BROWSER_IPC,
  type DesktopBrowserBridge,
  type DesktopBrowserLeaseId,
} from "@minke/harness-overlay/shared-browser-contract.ts";

/** DSH's lease-scoped bridge with one event subscription per application document. */
export function createDesktopBrowserBridge(ipc: Pick<IpcRenderer, "on" | "off" | "invoke">): {
  browser: DesktopBrowserBridge;
  dispose(): void;
} {
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>();
  const onOpenRequested = (_event: unknown, request: unknown): void => {
    if (typeof request !== "object" || request === null || !("lease" in request) || !("url" in request)
      || typeof request.lease !== "string" || typeof request.url !== "string") return;
    for (const listener of [...listeners.get(request.lease as DesktopBrowserLeaseId) ?? []]) {
      try { listener(request.url); }
      catch (error) { console.error("Desktop browser link handler failed", error); }
    }
  };
  ipc.on(DESKTOP_BROWSER_IPC.openRequested, onOpenRequested);
  return {
    browser: Object.freeze<DesktopBrowserBridge>({
      acquire: workspace => ipc.invoke(DESKTOP_BROWSER_IPC.acquire, workspace),
      release: lease => ipc.invoke(DESKTOP_BROWSER_IPC.release, lease),
      onOpenRequested(lease, listener) {
        let callbacks = listeners.get(lease);
        if (callbacks === undefined) { callbacks = new Set(); listeners.set(lease, callbacks); }
        callbacks.add(listener);
        return () => {
          callbacks.delete(listener);
          if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease);
        };
      },
    }),
    dispose() {
      ipc.off(DESKTOP_BROWSER_IPC.openRequested, onOpenRequested);
      listeners.clear();
    },
  };
}
