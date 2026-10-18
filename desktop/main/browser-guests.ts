/** Adapted from DSH Desktop browser-guests.ts; Minke adds a persistent account
 * and its existing trusted link/history extensions.
 *
 * MIT License
 * Copyright (c) 2026 DeepSeek
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { randomUUID } from "node:crypto";
import { app, session, type IpcMain, type IpcMainInvokeEvent, type WebContents, type Session } from "electron";
import {
  DESKTOP_BROWSER_IPC, PERSISTENT_BROWSER_WORKSPACE,
  type DesktopBrowserLeaseId, type DesktopBrowserOpenRequest, type DesktopBrowserReservation,
} from "@minke/harness-overlay/shared-browser-contract.ts";
import { TABS_WEB_PARTITION } from "@minke/harness-overlay/tabs/contract.ts";
import { TABS_WEB_EXTERNAL_LINK_CHANNEL } from "@minke/harness-overlay/tabs/web-link-contract.ts";
import { bindWebTabHistory } from "./tabs/history.ts";
import { canGrantTabWebPermission, openUserGestureTabLinkExternally } from "./tabs/security.ts";
import type { AgentBrowserRuntime } from "./agent-browser";
import type { ExternalTabOpener, TabsAuthorization } from "./tabs/types.ts";

interface GuestLease {
  readonly owner: WebContents;
  readonly partition: string;
  readonly session: Session;
  readonly persistent: boolean;
  attached: boolean;
  guest?: WebContents;
  dispose?: () => void;
}

interface BrowserGuestOptions {
  harnessUrl(): string | undefined;
  readonly preload: string;
  readonly external: ExternalTabOpener;
  readonly agentBrowser?: AgentBrowserRuntime;
}

/** One owner for native Browser and persistent Minke Browser leases. */
export class DesktopBrowserGuests {
  readonly #options: BrowserGuestOptions;
  readonly #partitions = new Map<string, { partition: string; session: Session }>();
  readonly #leases = new Map<DesktopBrowserLeaseId, GuestLease>();
  #userAgent: string | undefined;

  constructor(options: BrowserGuestOptions) { this.#options = options; }

  setUserAgent(userAgent: string): void {
    this.#userAgent = userAgent;
    for (const entry of this.#partitions.values()) entry.session.setUserAgent(userAgent);
  }

  acquire(owner: WebContents, workspace: unknown): DesktopBrowserReservation {
    if (typeof workspace !== "string" || workspace.length === 0 || workspace.length > 4096) {
      throw new Error("desktop browser: a workspace storage identity is required");
    }
    const persistent = workspace === PERSISTENT_BROWSER_WORKSPACE;
    let storage = this.#partitions.get(workspace);
    if (storage === undefined) {
      const partition = persistent ? TABS_WEB_PARTITION : `dsh-sidebar-browser-${randomUUID()}`;
      const browserSession = session.fromPartition(partition);
      this.#configureSession(browserSession, persistent);
      storage = { partition, session: browserSession };
      this.#partitions.set(workspace, storage);
    }
    const lease = randomUUID() as DesktopBrowserLeaseId;
    this.#leases.set(lease, { owner, ...storage, persistent, attached: false });
    return { lease, partition: storage.partition };
  }

  async release(owner: WebContents, id: unknown): Promise<void> {
    if (typeof id !== "string") throw new Error("desktop browser: invalid guest lease");
    const key = id as DesktopBrowserLeaseId;
    const lease = this.#leases.get(key);
    if (lease === undefined) return;
    if (lease.owner !== owner) throw new Error("desktop browser: guest belongs to another window");
    this.#leases.delete(key);
    lease.dispose?.();
    const guest = lease.guest;
    if (guest !== undefined && !guest.isDestroyed()) {
      const destroyed = new Promise<void>(resolve => { guest.once("destroyed", resolve); });
      guest.close({ waitForBeforeUnload: false });
      await destroyed;
    }
  }

  /** Bind before the owning Host document can create either kind of guest. */
  bind(ipc: Pick<IpcMain, "handle" | "removeHandler" | "on" | "removeListener">,
    owner: WebContents, authorize: TabsAuthorization,
    attachInput: (guest: WebContents, name: string) => (() => void) = () => () => {},
  ): { dispose(): void } {
    const pendingGuests = new Set<WebContents>();
    const assertSender = (event: IpcMainInvokeEvent): void => {
      if (event.sender !== owner || event.senderFrame !== owner.mainFrame || !authorize(event)) {
        throw new Error("desktop browser: rejected sender");
      }
    };
    const acquire = (event: IpcMainInvokeEvent, workspace: unknown): DesktopBrowserReservation => {
      assertSender(event);
      return this.acquire(owner, workspace);
    };
    const release = (event: IpcMainInvokeEvent, lease: unknown): Promise<void> => {
      assertSender(event);
      return this.release(owner, lease);
    };
    const willAttach = (_event: Electron.Event, preferences: Electron.WebPreferences, params: Record<string, string>): void => {
      const agent = this.#options.agentBrowser?.secureWebview(preferences, params);
      if (agent === "secured") return;
      const id = params.src?.startsWith("about:blank#") ? params.src.slice("about:blank#".length) : "";
      const lease = this.#leases.get(id as DesktopBrowserLeaseId);
      if (agent === "rejected" || lease === undefined || lease.owner !== owner || lease.attached || params.partition !== lease.partition) {
        _event.preventDefault();
        return;
      }
      lease.attached = true;
      // Preserve Electron's popup dispatch flag; our handler denies native windows.
      for (const key of Object.keys(preferences)) if (key !== "disablePopups") Reflect.deleteProperty(preferences, key);
      Object.assign(preferences, {
        partition: lease.partition, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
        webviewTag: false, plugins: false, navigateOnDragDrop: false, disableDialogs: !lease.persistent,
        safeDialogs: true, devTools: !app.isPackaged,
        ...(lease.persistent ? { preload: this.#options.preload } : {}),
      });
      delete params.preload;
      delete params.webpreferences;
      delete params.useragent;
      params.httpreferrer = "";
    };
    const didAttach = (_event: Electron.Event, guest: WebContents): void => {
      if (this.#options.agentBrowser?.attachGuest(owner, guest)) {
        if (guest.isDestroyed()) return;
        const dispose = attachInput(guest, `minke-guest-${guest.id}`);
        guest.once("destroyed", dispose);
        return;
      }
      pendingGuests.add(guest);
      let attached: DesktopBrowserLeaseId | undefined;
      guest.once("dom-ready", () => {
        pendingGuests.delete(guest);
        const url = guest.getURL();
        const id = (url.startsWith("about:blank#") ? url.slice("about:blank#".length) : "") as DesktopBrowserLeaseId;
        const lease = this.#leases.get(id);
        if (lease === undefined || !lease.attached || lease.owner !== owner || lease.guest !== undefined
          || lease.session !== guest.session || guest.hostWebContents !== owner) {
          guest.close({ waitForBeforeUnload: false });
          return;
        }
        attached = id;
        lease.guest = guest;
        const releaseInput = attachInput(guest, id);
        const releaseHistory = this.#options.agentBrowser === undefined ? () => {}
          : bindWebTabHistory(guest, this.#options.agentBrowser);
        let disposed = false;
        lease.dispose = () => {
          if (disposed) return;
          disposed = true;
          releaseInput();
          releaseHistory();
        };
      });
      guest.once("destroyed", () => {
        pendingGuests.delete(guest);
        if (attached === undefined) return;
        const lease = this.#leases.get(attached);
        lease?.dispose?.();
        this.#leases.delete(attached);
      });
      guest.setWindowOpenHandler(({ url, postBody }) => {
        if (attached !== undefined && postBody === undefined) this.#openRequested(owner, attached, guest, url);
        return { action: "deny" };
      });
      guest.on("will-frame-navigate", event => {
        if (event.isMainFrame && !this.#allowedNavigation(event.url)) event.preventDefault();
      });
      guest.on("will-redirect", (event, url, _inPlace, mainFrame) => {
        if (mainFrame && !this.#allowedNavigation(url)) event.preventDefault();
      });
      guest.on("will-attach-webview", event => event.preventDefault());
      guest.on("login", (event, _details, _authInfo, callback) => { event.preventDefault(); callback(); });
    };
    const externalLink = (event: Electron.IpcMainEvent, candidate: unknown): void => {
      if (event.senderFrame !== event.sender.mainFrame || typeof candidate !== "string") return;
      const entry = [...this.#leases].find(([, lease]) => lease.owner === owner && lease.guest === event.sender && lease.persistent);
      if (entry === undefined) return;
      if (URL.canParse(candidate) && ["http:", "https:"].includes(new URL(candidate).protocol)) {
        this.#openRequested(owner, entry[0], event.sender, candidate);
      } else openUserGestureTabLinkExternally(this.#options.external, candidate);
    };
    const releaseAll = (): void => {
      for (const [id, lease] of this.#leases) if (lease.owner === owner) {
        void this.release(owner, id).catch(error => console.error("Desktop browser release failed", error));
      }
      for (const guest of pendingGuests) if (!guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
      pendingGuests.clear();
    };
    const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (mainFrame && !inPlace) releaseAll();
    };
    ipc.handle(DESKTOP_BROWSER_IPC.acquire, acquire);
    ipc.handle(DESKTOP_BROWSER_IPC.release, release);
    ipc.on(TABS_WEB_EXTERNAL_LINK_CHANNEL, externalLink);
    owner.on("will-attach-webview", willAttach);
    owner.on("did-attach-webview", didAttach);
    owner.on("did-start-navigation", navigate);
    owner.on("render-process-gone", releaseAll);
    owner.once("destroyed", releaseAll);
    let disposed = false;
    return { dispose: () => {
      if (disposed) return;
      disposed = true;
      ipc.removeHandler(DESKTOP_BROWSER_IPC.acquire);
      ipc.removeHandler(DESKTOP_BROWSER_IPC.release);
      ipc.removeListener(TABS_WEB_EXTERNAL_LINK_CHANNEL, externalLink);
      owner.removeListener("will-attach-webview", willAttach);
      owner.removeListener("did-attach-webview", didAttach);
      owner.removeListener("did-start-navigation", navigate);
      owner.removeListener("render-process-gone", releaseAll);
      owner.removeListener("destroyed", releaseAll);
      releaseAll();
    } };
  }

  #openRequested(owner: WebContents, id: DesktopBrowserLeaseId, guest: WebContents, url: string): void {
    if (this.#leases.get(id)?.guest !== guest || owner.isDestroyed() || !this.#allowedNavigation(url)) return;
    const request: DesktopBrowserOpenRequest = { lease: id, url: new URL(url).href };
    owner.send(DESKTOP_BROWSER_IPC.openRequested, request);
  }

  #configureSession(browserSession: Session, persistent: boolean): void {
    if (this.#userAgent !== undefined) browserSession.setUserAgent(this.#userAgent);
    browserSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(persistent && canGrantTabWebPermission(permission, details.requestingUrl));
    });
    browserSession.setPermissionCheckHandler((_contents, permission, origin, details) =>
      persistent && canGrantTabWebPermission(permission, details.requestingUrl ?? origin));
    browserSession.setDevicePermissionHandler(() => false);
    browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    if (!persistent) browserSession.on("will-download", event => event.preventDefault());
    browserSession.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      callback({ cancel: ["http:", "https:", "ws:", "wss:"].includes(url.protocol)
        ? url.username !== "" || url.password !== "" || this.#isApplicationHost(url)
        : !["about:", "data:", "blob:"].includes(url.protocol) });
    });
  }

  #allowedNavigation(value: string): boolean {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "" && !this.#isApplicationHost(url);
  }

  #isApplicationHost(url: URL): boolean {
    const value = this.#options.harnessUrl();
    if (value === undefined) return false;
    const host = new URL(value);
    return url.port === host.port && (url.hostname === host.hostname || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  }
}
