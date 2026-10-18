import type { WebviewTag } from "electron";
import {
  PERSISTENT_BROWSER_WORKSPACE,
  type DesktopBrowserBridge,
  type DesktopBrowserLeaseId,
} from "@minke/harness-overlay/shared-browser-contract.ts";

interface PersistentBrowserOptions {
  readonly label: string;
  readonly allowPopups: boolean;
  ready(): void;
  openRequested(url: string): void;
  failed(error: unknown): void;
}

/** Use the same acquire/bootstrap/release protocol as DSH's native Browser. */
export function mountPersistentBrowser(
  host: Pick<HTMLElement, "append">,
  view: WebviewTag,
  options: PersistentBrowserOptions,
  bridge = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion: number; browser?: DesktopBrowserBridge };
  }).dshDesktop,
): () => void {
  let disposed = false;
  let lease: DesktopBrowserLeaseId | undefined;
  let unsubscribe: (() => void) | undefined;
  const browser = bridge?.protocolVersion === 1 ? bridge.browser : undefined;
  const fail = (error: unknown): void => { if (!disposed) options.failed(error); };
  const release = (id: DesktopBrowserLeaseId): void => {
    void browser?.release(id).catch(error => console.error("Desktop browser guest release failed", error));
  };
  const committed = (event: Event): void => {
    const url = (event as Event & { url: string }).url;
    if (!URL.canParse(url) || !["http:", "https:"].includes(new URL(url).protocol)) return;
    // The approved bootstrap document must never appear in the user's Back history.
    view.clearHistory();
    view.removeEventListener("did-navigate", committed);
  };
  const ready = (): void => {
    view.removeEventListener("dom-ready", ready);
    if (disposed) return;
    try {
      options.ready();
    } catch (error) { fail(error); dispose(); }
  };
  const lost = (): void => {
    if (disposed) return;
    options.failed(new Error("Browser guest is unavailable"));
    dispose();
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    view.removeEventListener("dom-ready", ready);
    view.removeEventListener("did-navigate", committed);
    view.removeEventListener("render-process-gone", lost);
    view.removeEventListener("destroyed", lost);
    unsubscribe?.();
    view.remove();
    if (lease !== undefined) release(lease);
  };
  view.className = "minke-tabs-view__guest";
  view.setAttribute("aria-label", options.label);
  view.setAttribute("data-sidebar-browser-frame", "webview");
  view.addEventListener("dom-ready", ready);
  view.addEventListener("did-navigate", committed);
  view.addEventListener("render-process-gone", lost);
  view.addEventListener("destroyed", lost);
  void (async () => {
    if (browser === undefined) throw new Error("Desktop browser bridge is unavailable");
    const reservation = await browser.acquire(PERSISTENT_BROWSER_WORKSPACE);
    if (disposed) { release(reservation.lease); return; }
    lease = reservation.lease;
    view.setAttribute("name", reservation.lease);
    view.setAttribute("partition", reservation.partition);
    if (options.allowPopups) view.setAttribute("allowpopups", "");
    view.setAttribute("src", "about:blank#" + reservation.lease);
    unsubscribe = browser.onOpenRequested(reservation.lease, url => {
      if (!disposed) options.openRequested(url);
    });
    host.append(view);
  })().catch(error => { fail(error); dispose(); });
  return dispose;
}
