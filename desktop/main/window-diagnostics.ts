import type { WebContents } from "electron";

/** Main-frame failures share the application's recovery flow; guests own theirs. */
export function bindWindowDiagnostics(
  contents: Pick<WebContents, "on" | "off">,
  report: (error: Error) => void,
  consoleError: (message: string) => void,
): () => void {
  const preload = (_event: unknown, _path: string, error: Error): void => report(error);
  const gone = (_event: unknown, details: Electron.RenderProcessGoneDetails): void => {
    if (details.reason !== "clean-exit") report(new Error(`Minke renderer exited: ${details.reason}`));
  };
  const load = (_event: unknown, code: number, description: string, _url: string, main: boolean): void => {
    if (main && code !== -3) report(new Error(`Minke page failed to load (${String(code)}: ${description})`));
  };
  const message = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.level === "error") consoleError(`${details.sourceId}:${String(details.lineNumber)} ${details.message}`);
  };
  contents.on("preload-error", preload);
  contents.on("render-process-gone", gone);
  contents.on("did-fail-load", load);
  contents.on("console-message", message);
  return () => {
    contents.off("preload-error", preload);
    contents.off("render-process-gone", gone);
    contents.off("did-fail-load", load);
    contents.off("console-message", message);
  };
}
