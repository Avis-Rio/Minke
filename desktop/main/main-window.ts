import { DesktopBrowserGuests } from "./browser-guests.ts";
import { bindWindowDiagnostics } from "./window-diagnostics.ts";
import { bindWindowContextMenu } from "./window-context-menu.ts";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type SaveDialogOptions,
  type Session,
  type WebContents,
} from "electron";
import { join, parse } from "node:path";
import {
  DesktopLocaleRuntime,
  type DesktopMessageKey,
  type DesktopTranslateParams,
} from "@minke/desktop/i18n";
import {
  type DesktopLocale,
} from "@minke/desktop/locale-contract";
import type {
  AgentBrowserRuntime,
} from "./agent-browser";
import {
  installHarnessPermissionPolicy,
} from "./harness-permission-policy";
import {
  macOSWindowOptions,
} from "./macos-window";
import { bindMainWindowDevToolsShortcut } from "./main-window-devtools";
import { createStatefulMainWindow } from "./main-window-state";
import {
  minkeConfigFilePath,
} from "./minke-config";
import { isInternalNavigation } from "./navigation-policy";
import {
  bindSessionLogExport,
  type SessionLogExportBinding,
} from "./session-export";
import {
  bindTabs,
  type TabsBinding,
} from "./tabs";
import { bindWindowLocale, readHarnessLocaleBootstrap } from "./window-locale";
import { bindWindowTheme } from "./window-theme";
import { bindWindowFullscreen } from "./window-fullscreen.ts";

const PRODUCT_NAME = "Minke";
const BACKGROUND_COLOR = "#0b1220";
const MAIN_WINDOW_PARTITION = "minke-main-window";

export interface MainWindowRuntimeOptions {
  agentBrowser: AgentBrowserRuntime;
  locale: DesktopLocaleRuntime;
  harnessUrl(): string | undefined;
  attachHarness(window: BrowserWindow): Promise<void>;
  refreshMenu(): void;
  attachShortcuts?(window: BrowserWindow): void;
  attachGuestShortcuts?(window: BrowserWindow, guest: WebContents, name: string): (() => void) | undefined;
  reportFailure?(error: Error): void;
  consoleError?(message: string): void;
  canClose?(): boolean;
  requestQuit?(): void;
  sessionEnding?(): void;
  sessionContinuing?(): void;
}

function canOpenExternally(value: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(
      new URL(value).protocol,
    );
  } catch {
    return false;
  }
}

/**
 * Owns the desktop BrowserWindow and every binding whose lifetime is scoped
 * to that window.
 */
export class MainWindowRuntime {
  readonly #options: MainWindowRuntimeOptions;
  readonly #surfaceSession: Session;
  #window: BrowserWindow | undefined;
  #sessionLogExportBinding: SessionLogExportBinding | undefined;
  #tabsBinding: TabsBinding | undefined;
  readonly #browserGuests: DesktopBrowserGuests;

  constructor(options: MainWindowRuntimeOptions) {
    this.#options = options;
    this.#browserGuests = new DesktopBrowserGuests({
      harnessUrl: options.harnessUrl, external: shell, agentBrowser: options.agentBrowser,
      preload: join(__dirname, "tabs-web-preload.js"),
    });
    this.#surfaceSession = session.fromPartition(
      MAIN_WINDOW_PARTITION,
    );
  }

  get current(): BrowserWindow | undefined {
    return this.#window;
  }

  installPermissionPolicy(): void {
    installHarnessPermissionPolicy(this.#surfaceSession, {
      harnessUrl: this.#options.harnessUrl,
      activeWebContents: () => this.#window?.webContents,
      microphone: {
        isGranted: () => process.platform !== "darwin" ||
          systemPreferences.getMediaAccessStatus("microphone") === "granted",
        request: () => process.platform === "darwin"
          ? systemPreferences.askForMediaAccess("microphone")
          : Promise.resolve(true),
      },
    });
  }

  /** The in-memory desktop surface never initializes Chromium's Keychain. */
  getUserAgent(): string {
    return this.#surfaceSession.getUserAgent();
  }

  /** Apply the desktop browser identity when a guest Session is first needed. */
  setWebUserAgent(userAgent: string): void {
    this.#browserGuests.setUserAgent(userAgent);
  }

  show(): void {
    const window = this.#window;
    if (window === undefined) {
      void this.create();
      return;
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  async create(): Promise<BrowserWindow> {
    const window = createStatefulMainWindow(
      minkeConfigFilePath(app.getPath("userData")),
      (bounds) => new BrowserWindow({
        title: PRODUCT_NAME,
        icon: this.#appIconPath(),
        ...bounds,
        minWidth: 960,
        minHeight: 640,
        show: false,
        backgroundColor: BACKGROUND_COLOR,
        ...macOSWindowOptions(),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: join(__dirname, "desktop-preload.js"),
          sandbox: true,
          session: this.#surfaceSession,
          webSecurity: true,
          webviewTag: true,
          transparent: process.platform === "darwin",
        },
      }),
    );
    bindMainWindowDevToolsShortcut(Menu);
    const authorizeWindow = (candidate: unknown): boolean => {
      const event = candidate as IpcMainEvent;
      return event.senderFrame === window.webContents.mainFrame && this.authorize(event, window);
    };
    const windowTheme = bindWindowTheme(window, nativeTheme, authorizeWindow);
    const disposeFullscreen = bindWindowFullscreen(window);
    const windowLocale = bindWindowLocale(
      window,
      this.#options.locale,
      authorizeWindow,
      async () => {
        const origin = this.#options.harnessUrl();
        if (origin === undefined) throw new Error("locale bootstrap: Harness is unavailable");
        return readHarnessLocaleBootstrap(origin, app.getPreferredSystemLanguages(),
          (url, init) => this.#surfaceSession.fetch(url, init));
      },
    );
    this.#window = window;
    this.#options.attachShortcuts?.(window);
    this.#options.refreshMenu();
    this.#protectNavigation(window);
    const disposeContextMenu = bindWindowContextMenu(window, Menu, key => this.#text(key));

    const tabsBinding = bindTabs(
      ipcMain,
      window.webContents,
      shell,
      (candidate) => this.authorize(candidate, window),
      {
        fileSystemRoot: parse(app.getPath("home")).root,
        minkeConfigPath: minkeConfigFilePath(
          app.getPath("userData"),
        ),
        agentBrowser: this.#options.agentBrowser,
      },
    );
    this.#tabsBinding = tabsBinding;
    const browserBinding = this.#browserGuests.bind(ipcMain, window.webContents,
      candidate => this.authorize(candidate, window),
      (guest, name) => this.#options.attachGuestShortcuts?.(window, guest, name) ?? (() => {}));

    const sessionLogExportBinding = bindSessionLogExport(
      window.webContents.session,
      window.webContents,
      shell,
      {
        harnessUrl: this.#options.harnessUrl,
        saveDialogOptions: (suggestedFilename) =>
          this.#sessionExportSaveDialogOptions(suggestedFilename),
        reportError: (error) => {
          void dialog
            .showMessageBox(window, {
              type: "error",
              title: this.#text("sessionExport.failedTitle"),
              message: this.#text("sessionExport.failedMessage"),
              detail: error.message,
              buttons: [this.#text("sessionExport.ok")],
              defaultId: 0,
              noLink: true,
            })
            .catch((dialogError: unknown) => {
              console.error(
                "Unable to show Session export error:",
                dialogError,
              );
            });
        },
      },
    );
    this.#sessionLogExportBinding = sessionLogExportBinding;

    const disposeDiagnostics = bindWindowDiagnostics(window.webContents,
      error => { if (!window.isDestroyed()) this.#options.reportFailure?.(error); },
      message => this.#options.consoleError?.(message));
    window.on("close", event => {
      if (process.platform !== "darwin" && this.#options.canClose?.() === false) {
        event.preventDefault();
        this.#options.requestQuit?.();
      }
    });
    if (process.platform === "win32") window.on("session-end", () => this.#options.sessionEnding?.());
    else {
      window.on("focus", () => this.#options.sessionContinuing?.());
      window.on("show", () => this.#options.sessionContinuing?.());
    }
    window.once("ready-to-show", () => window.show());
    window.once("closed", () => {
      disposeDiagnostics();
      disposeContextMenu();
      sessionLogExportBinding.dispose();
      browserBinding.dispose();
      tabsBinding.dispose();
      windowLocale.dispose();
      windowTheme.dispose();
      disposeFullscreen();
      if (this.#sessionLogExportBinding === sessionLogExportBinding) {
        this.#sessionLogExportBinding = undefined;
      }
      if (this.#tabsBinding === tabsBinding) {
        this.#tabsBinding = undefined;
      }
      if (this.#window === window) this.#window = undefined;
    });

    await this.#loadBootstrap(window);
    await this.#options.attachHarness(window);
    return window;
  }

  authorize(
    candidate: Pick<IpcMainEvent, "sender" | "senderFrame">,
    window: BrowserWindow | undefined = this.#window,
  ): boolean {
    return (
      window !== undefined &&
      candidate.sender === window.webContents &&
      candidate.senderFrame !== null &&
      this.#isHarnessUrl(candidate.senderFrame.url)
    );
  }

  #activeLocale(): DesktopLocale {
    return this.#options.locale.getSnapshot().active;
  }

  #text(
    key: DesktopMessageKey,
    params?: DesktopTranslateParams,
  ): string {
    return this.#options.locale.t(key, params);
  }

  #bootstrapUrl(): string | undefined {
    return MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined;
  }

  #appIconPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(
          app.getAppPath(),
          "resources",
          "icons",
          "icon.png",
        );
  }

  #sessionExportSaveDialogOptions(
    suggestedFilename: string,
  ): SaveDialogOptions {
    return {
      title: this.#text("sessionExport.saveDialogTitle"),
      defaultPath: join(
        app.getPath("downloads"),
        suggestedFilename,
      ),
      filters: [
        {
          name: this.#text("sessionExport.zipFilter"),
          extensions: ["zip"],
        },
      ],
      properties: [
        "createDirectory",
        "showOverwriteConfirmation",
      ],
    };
  }

  async #loadBootstrap(window: BrowserWindow): Promise<void> {
    const developmentUrl = this.#bootstrapUrl();
    if (developmentUrl !== undefined) {
      const url = new URL(developmentUrl);
      url.searchParams.set("locale", this.#activeLocale());
      await window.loadURL(url.toString());
      return;
    }
    await window.loadFile(
      join(
        __dirname,
        `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`,
      ),
      {
        query: { locale: this.#activeLocale() },
      },
    );
  }

  #isHarnessUrl(value: string): boolean {
    const harnessUrl = this.#options.harnessUrl();
    if (harnessUrl === undefined) return false;
    try {
      return new URL(value).origin === new URL(harnessUrl).origin;
    } catch {
      return false;
    }
  }

  #protectNavigation(window: BrowserWindow): void {
    window.webContents.on("will-navigate", (details) => {
      if (
        isInternalNavigation(
          details.url,
          [this.#bootstrapUrl(), this.#options.harnessUrl()],
        )
      ) {
        return;
      }
      details.preventDefault();
      if (canOpenExternally(details.url)) {
        void shell.openExternal(details.url);
      }
    });

    window.webContents.setWindowOpenHandler(({ url }) => {
      if (this.#isHarnessUrl(url)) {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            backgroundColor: BACKGROUND_COLOR,
            webPreferences: {
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              webSecurity: true,
            },
          },
        };
      }
      if (canOpenExternally(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });
  }
}
