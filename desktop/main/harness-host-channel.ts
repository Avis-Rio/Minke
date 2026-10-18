import type { ChildProcess } from "node:child_process";

export interface DesktopQuitInspection {
  readonly activeTasks: boolean;
  readonly scheduledTasks: boolean;
}

/** Redact startup capabilities before displaying or persisting diagnostics. */
export function redactLaunchTokens(value: string): string {
  return value.replace(/([?&]token=)[^&\s)]*/giu, "$1<redacted>");
}

/** DSH Desktop lifecycle over the existing private parent/child IPC channel. */
export class HarnessHostChannel {
  readonly ready: Promise<string>;
  shutdownCompleted = false;
  diagnostic: string | undefined;
  readonly #child: ChildProcess;
  readonly #output: () => string;
  readonly #pending = new Map<number, {
    resolve: (inspection: DesktopQuitInspection) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  #resolve!: (url: string) => void;
  #reject!: (error: Error) => void;
  #timer: NodeJS.Timeout;
  #settled = false;
  #disposed = false;
  #nextRequestId = 1;

  constructor(child: ChildProcess, timeoutMs: number, output: () => string) {
    this.#child = child;
    this.#output = output;
    this.ready = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.#timer = setTimeout(() => this.#fail(new Error(
      `Harness did not become ready within ${String(timeoutMs)} ms\n${output()}`,
    )), timeoutMs);
    child.on("message", this.#onMessage);
    child.on("error", this.#onError);
    child.on("exit", this.#onExit);
    child.on("disconnect", this.#onDisconnect);
  }

  inspectQuit(timeoutMs = 2_000): Promise<DesktopQuitInspection> {
    if (this.#disposed || !this.#child.connected) return Promise.reject(new Error("Desktop Host is unavailable"));
    const requestId = this.#nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error("Desktop task inspection timed out"));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        this.#child.send({ type: "quit-inspection", requestId }, error => {
          if (error != null) this.#rejectRequest(requestId, error);
        });
      } catch (error) {
        this.#rejectRequest(requestId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  requestShutdown(): void {
    if (this.#disposed || !this.#child.connected) return;
    try {
      this.#child.send({ type: "shutdown" }, () => {});
    } catch {
      // The caller bounds shutdown and escalates if the IPC pipe has closed.
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#fail(new Error("Desktop Host channel closed"));
    this.#child.off("message", this.#onMessage);
    this.#child.off("error", this.#onError);
    this.#child.off("exit", this.#onExit);
    this.#child.off("disconnect", this.#onDisconnect);
  }

  readonly #onMessage = (message: unknown): void => {
    if (typeof message !== "object" || message === null) return;
    const value = message as Record<string, unknown>;
    if (value.type === "ready" && typeof value.url === "string" && !this.#settled) {
      this.#settled = true;
      clearTimeout(this.#timer);
      this.#resolve(value.url);
    } else if (value.type === "fatal" && typeof value.message === "string") {
      this.diagnostic = redactLaunchTokens(
        typeof value.diagnostic === "string" ? value.diagnostic.slice(0, 64 * 1024) : value.message,
      );
      this.#fail(new Error(this.diagnostic));
    } else if (value.type === "shutdown-complete") {
      this.shutdownCompleted = true;
    } else if (value.type === "quit-inspection" && Number.isSafeInteger(value.requestId)) {
      const requestId = value.requestId as number;
      if (typeof value.error === "string") {
        this.#rejectRequest(requestId, new Error(redactLaunchTokens(value.error)));
      } else if (typeof value.activeTasks === "boolean" && typeof value.scheduledTasks === "boolean") {
        const pending = this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve({ activeTasks: value.activeTasks, scheduledTasks: value.scheduledTasks });
      }
    }
  };

  readonly #onError = (error: Error): void => this.#fail(error);
  readonly #onExit = (code: number | null, signal: NodeJS.Signals | null): void => this.#fail(new Error(
    `Harness exited (code ${String(code)}, signal ${String(signal)})\n${this.diagnostic ?? this.#output()}`,
  ));
  readonly #onDisconnect = (): void => this.#fail(new Error("Desktop Host disconnected"));

  #rejectRequest(requestId: number, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (pending === undefined) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  #fail(error: Error): void {
    clearTimeout(this.#timer);
    if (!this.#settled) {
      this.#settled = true;
      this.#reject(error);
    }
    for (const id of this.#pending.keys()) this.#rejectRequest(id, error);
  }
}
