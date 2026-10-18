import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { DesktopMessageKey, DesktopTranslateParams } from "../i18n.ts";
import { formatDesktopFailure, type DesktopFailureSource } from "./crash-report.ts";

interface RecoveryOperations {
  text(key: DesktopMessageKey, params?: DesktopTranslateParams): string;
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  writeReport(error: unknown, source: DesktopFailureSource): Promise<string>;
  stop(): Promise<void>;
  canEnableSafeMode(): boolean;
  enableSafeMode(): Promise<void>;
  restart(): void;
  exit(): void;
}

/** A fatal failure owns one recovery flow until a complete application restart. */
export class DesktopFatalRecovery {
  readonly #operations: RecoveryOperations;
  #active = false;
  #disposed = false;
  constructor(operations: RecoveryOperations) { this.#operations = operations; }
  get active(): boolean { return this.#active; }
  dispose(): void { this.#disposed = true; }

  async report(error: unknown, source: DesktopFailureSource): Promise<void> {
    if (this.#active || this.#disposed) return;
    this.#active = true;
    const operations = this.#operations;
    const text = operations.text;
    let timer: NodeJS.Timeout | undefined;
    let reportPath: string | undefined;
    try {
      reportPath = await Promise.race([
        operations.writeReport(error, source),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000); }),
      ]);
    } catch (failure) { console.error("Unable to write Minke diagnostics", failure); }
    finally { clearTimeout(timer); }
    let detail = formatDesktopFailure(error);
    let message = text("recovery.message");
    while (!this.#disposed) {
      const safeMode = operations.canEnableSafeMode();
      const result = await operations.show({
        type: "error", title: text("recovery.title"), message,
        detail: `${detail.slice(-1_200)}${reportPath === undefined ? "" : `\n\n${text("recovery.report", { path: reportPath })}`}`,
        buttons: [text("runtime.restart"), text("runtime.quit"), ...(safeMode ? [text("recovery.safeMode")] : [])],
        defaultId: 0, cancelId: 1, noLink: true,
      });
      if (this.#disposed) return;
      if (result.response === 1) { operations.exit(); return; }
      try {
        await operations.stop();
        if (this.#disposed) return;
        if (result.response === 2 && safeMode) await operations.enableSafeMode();
        if (this.#disposed) return;
        operations.restart();
        return;
      } catch (failure) {
        detail = formatDesktopFailure(failure);
        message = text("recovery.failed");
      }
    }
  }
}
