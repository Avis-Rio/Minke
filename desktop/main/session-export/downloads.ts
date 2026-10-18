import type {
  DownloadItem,
  Event as ElectronEvent,
  SaveDialogOptions,
  Session,
  WebContents,
} from "electron";

type DownloadDoneListener = (
  event: ElectronEvent,
  state: "completed" | "cancelled" | "interrupted",
) => void;

export interface SessionLogExportBinding {
  dispose(): void;
}

export interface SessionLogExportOptions {
  harnessUrl(): string | undefined;
  saveDialogOptions(suggestedFilename: string): SaveDialogOptions;
  reportError(error: Error): void;
}

/** Recognize DSH's native download route and bound its suggested ZIP filename. */
function exportFilename(candidate: string, harnessUrl: string | undefined): string | undefined {
  if (harnessUrl === undefined) return undefined;
  try {
    const host = new URL(harnessUrl);
    const url = new URL(candidate);
    if (
      (host.protocol !== "http:" && host.protocol !== "https:") ||
      url.origin !== host.origin ||
      url.pathname !== "/api/session.export"
    ) return undefined;
    const sessionId = url.searchParams.get("sessionId");
    if (
      sessionId === null || sessionId.length === 0 || sessionId.length > 512 ||
      /[\u0000-\u001f\u007f]/u.test(sessionId)
    ) return undefined;
    return `dsh-session-${sessionId.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96)}.zip`;
  } catch {
    return undefined;
  }
}

/** DSH owns export requests; Electron adds native save, completion and reveal UI. */
export function bindSessionLogExport(
  downloadSession: Pick<Session, "on" | "removeListener">,
  webContents: WebContents,
  shell: { showItemInFolder(path: string): void },
  options: SessionLogExportOptions,
): SessionLogExportBinding {
  const downloadListeners = new Map<DownloadItem, DownloadDoneListener>();
  let disposed = false;

  const report = (cause: unknown): void => {
    if (disposed) return;
    try {
      options.reportError(cause instanceof Error ? cause : new Error(String(cause)));
    } catch (error) {
      console.error("Unable to present Session export failure:", error);
    }
  };

  const handleWillDownload = (
    event: ElectronEvent,
    item: DownloadItem,
    source: WebContents,
  ): void => {
    if (disposed || source !== webContents) return;
    const filename = exportFilename(item.getURL(), options.harnessUrl());
    if (filename === undefined) return;
    try {
      item.setSaveDialogOptions(options.saveDialogOptions(filename));
    } catch (error) {
      event.preventDefault();
      report(error);
      return;
    }

    const done: DownloadDoneListener = (_event, state) => {
      downloadListeners.delete(item);
      if (disposed || state === "cancelled") return;
      if (state !== "completed") {
        report(new Error(`Session export ${state}`));
        return;
      }
      try {
        const path = item.getSavePath();
        if (path === "") throw new Error("Session export completed without a save path");
        shell.showItemInFolder(path);
      } catch (error) {
        report(error);
      }
    };
    downloadListeners.set(item, done);
    item.once("done", done);
  };
  downloadSession.on("will-download", handleWillDownload);

  return Object.freeze({
    dispose(): void {
      if (disposed) return;
      disposed = true;
      downloadSession.removeListener("will-download", handleWillDownload);
      for (const [item, listener] of downloadListeners) item.removeListener("done", listener);
      downloadListeners.clear();
    },
  });
}
