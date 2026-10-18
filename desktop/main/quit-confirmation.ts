import type { MessageBoxOptions, MessageBoxReturnValue } from "electron";
import type { DesktopMessageKey } from "../i18n.ts";
import type { DesktopQuitInspection } from "./harness-host-channel.ts";

interface QuitConfirmationOptions {
  inspect(): Promise<DesktopQuitInspection> | undefined;
  text(key: DesktopMessageKey): string;
  show(options: MessageBoxOptions): Promise<MessageBoxReturnValue>;
  focus(): void;
}

/** One cancellable quit decision; no resource disposal happens before approval. */
export class DesktopQuitConfirmation {
  readonly #options: QuitConfirmationOptions;
  #pending: Promise<boolean> | undefined;
  #disposed = false;
  #generation = 0;

  constructor(options: QuitConfirmationOptions) { this.#options = options; }

  confirm(action: "quit" | "restart" = "quit"): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    if (this.#pending !== undefined) {
      this.#options.focus();
      return this.#pending;
    }
    const pending = this.#decide(action).finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    this.#pending = pending;
    return pending;
  }

  cancelPending(): void { this.#generation++; this.#pending = undefined; }
  dispose(): void { this.#disposed = true; this.cancelPending(); }

  async #decide(action: "quit" | "restart"): Promise<boolean> {
    const generation = this.#generation;
    const cancelled = (): boolean => this.#disposed || generation !== this.#generation;
    let inspection: DesktopQuitInspection | undefined;
    let key: DesktopMessageKey;
    try {
      inspection = await this.#options.inspect();
      if (inspection === undefined) return !cancelled();
      if (!inspection.activeTasks && !inspection.scheduledTasks) return !cancelled();
      key = inspection.activeTasks
        ? inspection.scheduledTasks ? "quit.activeAndScheduled" : "quit.active"
        : "quit.scheduled";
    } catch {
      key = "quit.unknown";
    }
    if (cancelled()) return false;
    const text = this.#options.text;
    const result = await this.#options.show({
      type: "warning", title: "Minke",
      message: text(action === "restart" ? "quit.restartTitle" : "quit.title"), detail: text(key),
      buttons: [text(action === "restart" ? "runtime.restart" : "runtime.quit"), text("quit.cancel")],
      defaultId: 0, cancelId: 1, noLink: true,
    });
    return !cancelled() && result.response === 0;
  }
}
