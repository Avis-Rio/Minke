export type {
  DesktopBrowserBridge,
  DesktopBrowserLeaseId,
  DesktopBrowserOpenRequest,
  DesktopBrowserReservation,
} from "@deepseek-ai/dsh-client-ui-sidebar-browser/types";

/** Wire names used by the pinned DSH Desktop implementation. */
export const DESKTOP_BROWSER_IPC = Object.freeze({
  acquire: "dsh-desktop:browser-acquire",
  release: "dsh-desktop:browser-release",
  openRequested: "dsh-desktop:browser-open-requested",
});

/** The explicit storage account for Minke's persistent Browser tab type. */
export const PERSISTENT_BROWSER_WORKSPACE = "minke:persistent-browser";
