import {
  app,
  powerMonitor,
  dialog,
  session,
  shell,
  type BrowserWindow,
  type DownloadItem,
  type MessageBoxOptions,
  type Session,
} from "electron";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  rename,
} from "node:fs/promises";
import { join } from "node:path";
import {
  type DesktopMessageKey,
  type DesktopTranslateParams,
} from "@minke/desktop/i18n";
import type { DesktopUpdatePresentation } from "@minke/harness-overlay/shared-updates-contract.ts";
import {
  assertTrustedDownloadUrlChain,
  fetchAppUpdate,
  type AppUpdate,
  type AppUpdateTarget,
  shouldConfirmUpdateDownload,
  verifyDownloadedUpdate,
} from "./app-update";
import { assertMacFileQuarantined } from "./macos-quarantine";
import { assertWindowsFileQuarantined } from "./windows-quarantine";

const INITIAL_CHECK_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CHECK_REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_START_TIMEOUT_MS = 30_000;
const UPDATE_SESSION_PARTITION = "minke-app-update";

export interface AppUpdateRuntimeOptions {
  target: AppUpdateTarget;
  autoDownload: boolean;
  currentVersion: string;
  userDataPath: string;
  window(): BrowserWindow | undefined;
  changed?(state: DesktopUpdatePresentation): void;
  text(
    key: DesktopMessageKey,
    params?: DesktopTranslateParams,
  ): string;
}

interface VerifiedUpdateDownload {
  directory: string;
  path: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readyDetailKey(
  update: AppUpdate,
): DesktopMessageKey {
  switch (update.target.installer) {
    case "dmg":
      return "update.readyDetail.dmg";
    case "exe":
      return "update.readyDetail.exe";
    case "deb":
      return "update.readyDetail.deb";
    case "rpm":
      return "update.readyDetail.rpm";
    case "appimage":
      return "update.readyDetail.appimage";
  }
}

/**
 * Checks GitHub for a trusted desktop release and opens its verified installer.
 * Installation remains an explicit user action on every supported platform.
 */
export class AppUpdateRuntime {
  readonly #options: AppUpdateRuntimeOptions;
  readonly #downloadSession: Session;
  #timer: NodeJS.Timeout | undefined;
  #started = false;
  #nextCheck = 0;
  #failures = 0;
  #checkPromise: Promise<void> | undefined;
  #presentation: DesktopUpdatePresentation = Object.freeze({ phase: "idle" });
  #manualCheckRequested = false;
  readonly #wake = (): void => {
    if (!this.#disposed && this.#started && Date.now() >= this.#nextCheck) this.#runAutomaticCheck();
  };
  #activeDownload: DownloadItem | undefined;
  #pendingDownload:
    | ((
        event: Electron.Event,
        item: DownloadItem,
      ) => void)
    | undefined;
  #offeredVersion: string | undefined;
  #checkAbort: AbortController | undefined;
  #autoDownload: boolean;
  #offering = false;
  #disposed = false;

  constructor(options: AppUpdateRuntimeOptions) {
    this.#options = options;
    this.#autoDownload = options.autoDownload;
    this.#downloadSession = session.fromPartition(
      UPDATE_SESSION_PARTITION,
      { cache: false },
    );
    this.#downloadSession.on(
      "will-download",
      this.#onWillDownload,
    );
  }

  start(): void {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    app.on("browser-window-focus", this.#wake);
    powerMonitor.on("resume", this.#wake);
    this.#schedule(INITIAL_CHECK_DELAY_MS);
  }

  #schedule(delay: number): void {
    if (this.#disposed || !this.#started) return;
    clearTimeout(this.#timer);
    this.#nextCheck = Date.now() + delay;
    this.#timer = setTimeout(() => this.#runAutomaticCheck(), delay);
    this.#timer.unref();
  }

  #scheduleAfterCheck(failed: boolean): void {
    this.#failures = failed ? this.#failures + 1 : 0;
    const delay = failed ? Math.min(6 * 60 * 60 * 1_000, 5 * 60 * 1_000 * 2 ** Math.min(this.#failures - 1, 10))
      : CHECK_INTERVAL_MS;
    this.#schedule(Math.round(delay * (0.9 + Math.random() * 0.2)));
  }

  setAutoDownload(autoDownload: boolean): void {
    this.#autoDownload = autoDownload;
  }

  status(): DesktopUpdatePresentation { return this.#presentation; }

  async open(): Promise<void> {
    await this.#checkForUpdates(true);
  }

  #publish(state: DesktopUpdatePresentation): void {
    if (this.#disposed || JSON.stringify(state) === JSON.stringify(this.#presentation)) return;
    this.#presentation = Object.freeze(state);
    this.#options.changed?.(this.#presentation);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    app.off("browser-window-focus", this.#wake);
    powerMonitor.off("resume", this.#wake);
    if (
      this.#activeDownload !== undefined &&
      this.#activeDownload.getState() === "progressing"
    ) {
      this.#activeDownload.cancel();
    }
    this.#activeDownload = undefined;
    this.#pendingDownload = undefined;
    this.#checkAbort?.abort();
    this.#checkAbort = undefined;
    this.#downloadSession.removeListener(
      "will-download",
      this.#onWillDownload,
    );
    this.#setProgress(-1);
  }

  #runAutomaticCheck(): void {
    void this.#checkForUpdates(false).catch((error: unknown) => {
      if (!this.#disposed) {
        console.error("Minke update check failed:", error);
      }
    });
  }

  #checkForUpdates(manual: boolean): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#offering) {
      this.#schedule(CHECK_INTERVAL_MS);
      return Promise.resolve();
    }
    this.#manualCheckRequested ||= manual;
    if (this.#checkPromise !== undefined) return this.#checkPromise;
    clearTimeout(this.#timer);
    const operation = this.#performCheck().then(result => {
      this.#scheduleAfterCheck(false);
      return result;
    }, (error: unknown) => {
      this.#publish({ phase: "error", failure: "check" });
      this.#scheduleAfterCheck(true);
      throw error;
    }).finally(() => {
      this.#checkPromise = undefined;
      this.#manualCheckRequested = false;
    });
    this.#checkPromise = operation;
    return operation;
  }

  async #performCheck(): Promise<void> {
    this.#publish({ phase: "checking" });
    const controller = new AbortController();
    this.#checkAbort = controller;
    const timeout = setTimeout(() => {
      controller.abort();
    }, CHECK_REQUEST_TIMEOUT_MS);
    timeout.unref();
    let update: AppUpdate | undefined;
    try {
      update = await fetchAppUpdate(
        (input, init) =>
          this.#downloadSession.fetch(input, {
            ...init,
            bypassCustomProtocolHandlers: true,
            signal: controller.signal,
          }),
        this.#options.currentVersion,
        this.#options.target,
      );
    } finally {
      clearTimeout(timeout);
      if (this.#checkAbort === controller) {
        this.#checkAbort = undefined;
      }
    }
    if (this.#disposed) return;
    if (update === undefined) {
      this.#publish({ phase: "idle" });
      if (this.#manualCheckRequested) await this.#showMessageBox({
        type: "info", title: this.#options.text("update.availableTitle"),
        message: this.#options.text("update.upToDate"),
      });
      return;
    }
    if (
      !this.#manualCheckRequested &&
      this.#offeredVersion === update.version
    ) {
      this.#publish({ phase: "available", version: update.version });
      return;
    }

    this.#offeredVersion = update.version;
    this.#publish({ phase: "available", version: update.version });
    this.#offering = true;
    void this.#offerUpdate(update)
      .catch((error: unknown) => {
        if (!this.#disposed) {
          console.error("Minke update flow failed:", error);
        }
      })
      .finally(() => {
        this.#offering = false;
      });
  }

  async #offerUpdate(update: AppUpdate): Promise<void> {
    let confirmed = !shouldConfirmUpdateDownload(this.#autoDownload);
    while (!this.#disposed) {
      let operation: "download" | "install" = "download";
      try {
        this.#publish({ phase: "available", version: update.version });
        let download = await this.#cachedDownload(update);
        if (download === undefined) {
          if (!confirmed) {
            const choice = await this.#showMessageBox({
              type: "info", title: this.#options.text("update.availableTitle"),
              message: this.#options.text("update.availableMessage", { version: update.version }),
              detail: this.#options.text("update.availableDetail", { current: this.#options.currentVersion }),
              buttons: [this.#options.text("update.download"), this.#options.text("update.later")],
              defaultId: 0, cancelId: 1, noLink: true,
            });
            if (choice.response !== 0 || this.#disposed) return;
            confirmed = true;
          }
          download = await this.#downloadAndVerify(update);
        }
        if (this.#disposed) return;
        // DSH ready means "Install and Restart". Minke opens an OS installer,
        // so a verified package remains available until the user installs it.
        this.#publish({ phase: "available", version: update.version });
        const ready = await this.#showMessageBox({
          type: "info", title: this.#options.text("update.readyTitle"),
          message: this.#options.text("update.readyMessage", { version: update.version }),
          detail: this.#options.text(readyDetailKey(update)),
          buttons: [this.#options.text(update.target.installer === "appimage" ? "update.showAppImage" : "update.openInstaller"),
            this.#options.text("update.later")], defaultId: 0, cancelId: 1, noLink: true,
        });
        // A prepared package stays available after Later, including after application restart.
        if (ready.response !== 0 || this.#disposed) return;
        operation = "install";
        this.#publish({ phase: "verifying", version: update.version });
        await this.#openVerifiedUpdate(update, download.path);
        this.#publish({ phase: "available", version: update.version });
        return;
      } catch (error) {
        this.#publish({ phase: "error", failure: operation, version: update.version });
        this.#offeredVersion = undefined;
        if (this.#disposed || !await this.#offerBrowserFallback(update, error)) return;
        confirmed = true;
      }
    }
  }

  #cachePath(update: AppUpdate): VerifiedUpdateDownload {
    const directory = join(this.#options.userDataPath, "updates", `ready-${update.asset.sha256}`);
    return { directory, path: join(directory, update.asset.name) };
  }

  async #cachedDownload(update: AppUpdate): Promise<VerifiedUpdateDownload | undefined> {
    const cached = this.#cachePath(update);
    try {
      const root = await lstat(join(this.#options.userDataPath, "updates"));
      if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("application update cache is not a private directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const directory = await lstat(cached.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("invalid cached update directory");
      // The expected digest comes from the checked immutable release, never from a cache manifest.
      await verifyDownloadedUpdate(cached.path, update.asset);
      await this.#assertPlatformProvenance(update, cached.path);
      return cached;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Discarding invalid cached update", error);
      await this.#discardDownload(cached);
      return undefined;
    }
  }

  async #assertPlatformProvenance(
    update: AppUpdate,
    path: string,
  ): Promise<void> {
    if (update.target.platform === "darwin") {
      await assertMacFileQuarantined(path);
    } else if (update.target.platform === "win32") {
      await assertWindowsFileQuarantined(path);
    }
  }

  async #openVerifiedUpdate(
    update: AppUpdate,
    path: string,
  ): Promise<void> {
    if (update.target.installer === "appimage") {
      await chmod(path, 0o700);
    }
    await verifyDownloadedUpdate(path, update.asset);
    await this.#assertPlatformProvenance(update, path);
    if (update.target.installer === "appimage") {
      shell.showItemInFolder(path);
      return;
    }
    const openError = await shell.openPath(path);
    if (openError !== "") {
      throw new Error(openError);
    }
  }

  async #downloadAndVerify(
    update: AppUpdate,
  ): Promise<VerifiedUpdateDownload> {
    this.#publish({ phase: "downloading", version: update.version, percent: 0 });
    const updatesRoot = join(
      this.#options.userDataPath,
      "updates",
    );
    await mkdir(updatesRoot, {
      recursive: true,
      mode: 0o700,
    });
    const updatesRootDetails = await lstat(updatesRoot);
    if (
      !updatesRootDetails.isDirectory() ||
      updatesRootDetails.isSymbolicLink()
    ) {
      throw new TypeError(
        "application update cache is not a private directory",
      );
    }
    await chmod(updatesRoot, 0o700);
    const downloadRoot = await mkdtemp(
      join(updatesRoot, `${update.version}-`),
    );
    await chmod(downloadRoot, 0o700);
    const destination = join(
      downloadRoot,
      update.asset.name,
    );
    try {
      await this.#download(update, destination);
      this.#publish({ phase: "verifying", version: update.version });
      await verifyDownloadedUpdate(destination, update.asset);
      await this.#assertPlatformProvenance(
        update,
        destination,
      );
      const cached = this.#cachePath(update);
      await rename(downloadRoot, cached.directory);
      return cached;
    } catch (error) {
      await rm(downloadRoot, {
        recursive: true,
        force: true,
      });
      throw error;
    } finally {
      this.#setProgress(-1);
    }
  }

  async #discardDownload(
    download: VerifiedUpdateDownload,
  ): Promise<void> {
    try {
      await rm(download.directory, {
        recursive: true,
        force: true,
      });
    } catch (error) {
      console.error(
        "Unable to remove discarded Minke update:",
        error,
      );
    }
  }

  #download(
    update: AppUpdate,
    destination: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (
        this.#pendingDownload !== undefined ||
        this.#activeDownload !== undefined
      ) {
        reject(new Error("another update download is active"));
        return;
      }
      let policyFailure: Error | undefined;
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimeout);
        if (this.#pendingDownload === onWillDownload) {
          this.#pendingDownload = undefined;
        }
        if (error === undefined) resolve();
        else reject(error);
      };
      const onWillDownload = (
        event: Electron.Event,
        item: DownloadItem,
      ) => {
        clearTimeout(startTimeout);
        if (settled) {
          event.preventDefault();
          return;
        }
        try {
          assertTrustedDownloadUrlChain(
            update.asset.url,
            item.getURLChain(),
          );
          item.setSavePath(destination);
        } catch (error) {
          event.preventDefault();
          settle(
            error instanceof Error
              ? error
              : new Error(String(error)),
          );
          return;
        }
        this.#activeDownload = item;
        item.on("updated", () => {
          try {
            assertTrustedDownloadUrlChain(
              update.asset.url,
              item.getURLChain(),
            );
            const total = item.getTotalBytes();
            if (total !== 0 && total !== update.asset.size) {
              throw new Error(
                "update server reported an unexpected installer size",
              );
            }
            const received = item.getReceivedBytes();
            if (received > update.asset.size) {
              throw new Error(
                "update download exceeded its declared size",
              );
            }
            this.#setProgress(
              Math.min(received / update.asset.size, 1),
            );
            this.#publish({ phase: "downloading", version: update.version,
              percent: Math.floor(Math.min(received / update.asset.size, 1) * 100) });
          } catch (error) {
            policyFailure =
              error instanceof Error
                ? error
                : new Error(String(error));
            item.cancel();
          }
        });
        item.once("done", (_doneEvent, state) => {
          this.#activeDownload = undefined;
          this.#setProgress(-1);
          if (policyFailure !== undefined) {
            settle(policyFailure);
            return;
          }
          if (state !== "completed") {
            settle(
              new Error(`update download ended as ${state}`),
            );
            return;
          }
          try {
            assertTrustedDownloadUrlChain(
              update.asset.url,
              item.getURLChain(),
            );
            settle();
          } catch (error) {
            settle(
              error instanceof Error
                ? error
                : new Error(String(error)),
            );
          }
        });
      };
      const startTimeout = setTimeout(() => {
        settle(new Error("update download did not start in time"));
      }, DOWNLOAD_START_TIMEOUT_MS);
      startTimeout.unref();
      this.#pendingDownload = onWillDownload;
      try {
        this.#downloadSession.downloadURL(update.asset.url, {
          headers: {
            Accept: "application/octet-stream",
            "User-Agent": `Minke/${this.#options.currentVersion}`,
          },
        });
      } catch (error) {
        settle(
          error instanceof Error
            ? error
            : new Error(String(error)),
        );
      }
    });
  }

  readonly #onWillDownload = (
    event: Electron.Event,
    item: DownloadItem,
  ): void => {
    const pending = this.#pendingDownload;
    this.#pendingDownload = undefined;
    if (pending === undefined || this.#disposed) {
      event.preventDefault();
      return;
    }
    pending(event, item);
  };

  async #offerBrowserFallback(
    update: AppUpdate,
    error: unknown,
  ): Promise<boolean> {
    console.error("Minke update download failed:", error);
    const choice = await this.#showMessageBox({
      type: "error",
      title: this.#options.text("update.failedTitle"),
      message: this.#options.text("update.failedMessage"),
      detail: this.#options.text("update.failedDetail", {
        error: errorMessage(error),
      }),
      buttons: [
        this.#options.text("update.retry"),
        this.#options.text("update.openReleasePage"),
        this.#options.text("update.cancel"),
      ],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (this.#disposed) return false;
    if (choice.response === 0) return true;
    if (choice.response !== 1) return false;
    await shell.openExternal(
      `https://github.com/lencx/Minke/releases/tag/${update.tag}`,
    );
    return false;
  }

  #showMessageBox(
    options: MessageBoxOptions,
  ): ReturnType<typeof dialog.showMessageBox> {
    const window = this.#options.window();
    return window === undefined || window.isDestroyed()
      ? dialog.showMessageBox(options)
      : dialog.showMessageBox(window, options);
  }

  #setProgress(value: number): void {
    const window = this.#options.window();
    if (window === undefined || window.isDestroyed()) return;
    window.setProgressBar(value);
  }
}
