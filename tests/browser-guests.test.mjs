import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bundledDesktop, until } from "./support/bundled-desktop.mjs";
import { DESKTOP_BROWSER_IPC as IPC, PERSISTENT_BROWSER_WORKSPACE } from "@minke/harness-overlay/shared-browser-contract.ts";
import { TABS_WEB_EXTERNAL_LINK_CHANNEL } from "@minke/harness-overlay/tabs/web-link-contract.ts";
import { createDesktopBrowserBridge } from "@minke/desktop/preload/browser.ts";
import { mountPersistentBrowser } from "@minke/harness-overlay/client/tabs/web/guest.ts";

function fixture() {
  const sessions = new Map();
  const { DesktopBrowserGuests } = bundledDesktop("desktop/main/browser-guests.ts", {
    app: { isPackaged: true },
    session: { fromPartition(partition) {
      if (!sessions.has(partition)) {
        const storage = new EventEmitter();
        Object.assign(storage, {
          setUserAgent(value) { this.ua = value; },
          setPermissionRequestHandler(handler) { this.permission = handler; },
          setPermissionCheckHandler(handler) { this.check = handler; },
          setDevicePermissionHandler(handler) { this.device = handler; },
          setDisplayMediaRequestHandler(handler) { this.display = handler; },
          webRequest: { onBeforeRequest(handler) { storage.request = handler; } },
        });
        sessions.set(partition, storage);
      }
      return sessions.get(partition);
    } },
  });
  const external = [], inputs = [], visits = [];
  const agentBrowser = { secureWebview: () => "unmatched", attachGuest: () => false,
    recordHumanNavigation: (...args) => visits.push(args), updateVisitTitle() {}, updateVisitFavicon() {} };
  const manager = new DesktopBrowserGuests({ harnessUrl: () => "http://localhost:4251", preload: "/trusted/link.js",
    external: { openExternal: async url => { external.push(url); } }, agentBrowser });
  const owner = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false,
    send: (...args) => messages.push(args) });
  const messages = [];
  const ipc = Object.assign(new EventEmitter(), { handlers: new Map(),
    handle(name, handler) { this.handlers.set(name, handler); }, removeHandler(name) { this.handlers.delete(name); } });
  const binding = manager.bind(ipc, owner, event => event.allowed === true, (guest, name) => {
    inputs.push(["attach", name]); return () => inputs.push(["dispose", name]);
  });
  const invoke = (name, value, event = {}) => ipc.handlers.get(name)({ sender: owner, senderFrame: owner.mainFrame, allowed: true, ...event }, value);
  const attach = (reservation, preferences = {}, overrides = {}) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    const params = { src: `about:blank#${reservation.lease}`, partition: reservation.partition, ...overrides };
    owner.emit("will-attach-webview", event, preferences, params);
    return { event, params, preferences };
  };
  const guest = (reservation, ready = true) => {
    const view = Object.assign(new EventEmitter(), {
      id: 13, mainFrame: {}, session: sessions.get(reservation.partition), hostWebContents: owner,
      url: `about:blank#${reservation.lease}`, destroyed: false,
      getURL() { return this.url; }, getTitle: () => "Fixture", isDestroyed() { return this.destroyed; },
      close(options) { assert.equal(options.waitForBeforeUnload, false); this.destroyed = true; this.emit("destroyed"); },
      setWindowOpenHandler(handler) { this.popup = handler; },
    });
    owner.emit("did-attach-webview", {}, view);
    if (ready) view.emit("dom-ready");
    return view;
  };
  return { manager, owner, ipc, invoke, attach, guest, binding, sessions, messages, external, inputs, visits, agentBrowser };
}

test("ordinary workspaces share only their process account; persistent tabs keep the existing login partition", async () => {
  const f = fixture();
  const a = f.invoke(IPC.acquire, "cwd:/a"), b = f.invoke(IPC.acquire, "cwd:/a"), c = f.invoke(IPC.acquire, "cwd:/b");
  assert.equal(a.partition, b.partition);
  assert.notEqual(a.lease, b.lease);
  assert.notEqual(a.partition, c.partition);
  assert.equal(a.partition.startsWith("persist:"), false);
  const saved = f.invoke(IPC.acquire, PERSISTENT_BROWSER_WORKSPACE);
  assert.equal(saved.partition, "persist:minke-tabs-web");
  f.manager.setUserAgent("Fixture UA");
  for (const session of f.sessions.values()) assert.equal(session.ua, "Fixture UA");
  await f.invoke(IPC.release, saved.lease);
  assert.equal(f.invoke(IPC.acquire, PERSISTENT_BROWSER_WORKSPACE).partition, saved.partition);
  const restarted = fixture();
  assert.notEqual(restarted.invoke(IPC.acquire, "cwd:/a").partition, a.partition);
  assert.equal(restarted.invoke(IPC.acquire, PERSISTENT_BROWSER_WORKSPACE).partition, saved.partition);
  f.binding.dispose(); restarted.binding.dispose();
});

test("acquire/release reject other windows, subframes, unauthorized documents and invalid identities", async () => {
  const f = fixture(), reservation = f.invoke(IPC.acquire, "cwd:/a");
  for (const event of [{ sender: {} }, { senderFrame: {} }, { allowed: false }]) {
    assert.throws(() => f.invoke(IPC.acquire, "cwd:/a", event), /rejected sender/);
    assert.throws(() => f.invoke(IPC.release, reservation.lease, event), /rejected sender/);
  }
  for (const value of [null, "", "a".repeat(4097)]) assert.throws(() => f.invoke(IPC.acquire, value), /identity/);
  await assert.rejects(f.manager.release({}, reservation.lease), /another window/);
  assert.equal(f.attach(reservation).event.prevented, false, "rejected release must not invalidate its owner's lease");
  f.binding.dispose();
});

test("admission needs an unused lease, matching partition and owner; it overwrites unsafe preferences", () => {
  const f = fixture(), a = f.invoke(IPC.acquire, "cwd:/a");
  for (const overrides of [{ src: "https://example.com" }, { src: "about:blank#forged" }, { partition: "persist:attacker" }]) {
    assert.equal(f.attach(a, {}, overrides).event.prevented, true);
  }
  const other = f.manager.acquire({}, "cwd:/a");
  assert.equal(f.attach(other).event.prevented, true);
  const unsafe = { preload: "/untrusted", nodeIntegration: true, nodeIntegrationInWorker: true,
    nodeIntegrationInSubFrames: true, webSecurity: false, sandbox: false, webviewTag: true, disablePopups: false };
  const result = f.attach(a, unsafe, { preload: "/bad", webpreferences: "nodeIntegration=yes", useragent: "forged" });
  assert.equal(result.event.prevented, false);
  assert.equal(unsafe.preload, undefined);
  assert.equal(unsafe.nodeIntegration, false); assert.equal(unsafe.nodeIntegrationInWorker, false);
  assert.equal(unsafe.nodeIntegrationInSubFrames, false); assert.equal(unsafe.webviewTag, false);
  assert.equal(unsafe.sandbox, true); assert.equal(unsafe.contextIsolation, true); assert.equal(unsafe.webSecurity, true);
  assert.equal(unsafe.disableDialogs, true); assert.equal(unsafe.disablePopups, false);
  assert.equal(result.params.preload, undefined); assert.equal(result.params.webpreferences, undefined);
  assert.equal(result.params.useragent, undefined);
  assert.equal(f.attach(a).event.prevented, true, "leases cannot be replayed");
  const persistent = f.invoke(IPC.acquire, PERSISTENT_BROWSER_WORKSPACE);
  assert.equal(f.attach(persistent).preferences.preload, "/trusted/link.js");
  f.binding.dispose();
});

test("release and owner loss dispose guests, input and history; late attachments cannot resurrect a lease", async () => {
  const f = fixture(), a = f.invoke(IPC.acquire, "cwd:/a");
  f.attach(a); const view = f.guest(a);
  view.emit("did-navigate", {}, "https://example.com");
  assert.equal(f.visits.length, 1);
  await f.invoke(IPC.release, a.lease);
  assert.equal(view.destroyed, true);
  assert.deepEqual(f.inputs, [["attach", a.lease], ["dispose", a.lease]]);
  view.emit("did-navigate", {}, "https://example.com/next");
  assert.equal(f.visits.length, 1);
  await f.invoke(IPC.release, a.lease);
  assert.equal(f.inputs.length, 2);
  const late = f.invoke(IPC.acquire, "cwd:/a"); f.attach(late);
  await f.invoke(IPC.release, late.lease);
  assert.equal(f.guest(late).destroyed, true);
  for (const reason of ["navigation", "render-process-gone", "destroyed", "dispose"]) {
    const pending = f.invoke(IPC.acquire, "cwd:/a"); f.attach(pending);
    const view = f.guest(pending, false);
    if (reason === "navigation") {
      f.owner.emit("did-start-navigation", {}, "http://localhost:4251/#x", true, true);
      assert.equal(view.destroyed, false);
      f.owner.emit("did-start-navigation", {}, "http://localhost:4251/", false, true);
    } else if (reason === "dispose") f.binding.dispose();
    else f.owner.emit(reason);
    assert.equal(view.destroyed, true);
  }
  assert.equal(f.ipc.handlers.size, 0);
  assert.equal(f.ipc.listenerCount(TABS_WEB_EXTERNAL_LINK_CHANNEL), 0);
});

test("native popups are lease scoped, while host URLs, credentials, custom schemes and POSTs stay blocked", () => {
  const f = fixture(), a = f.invoke(IPC.acquire, "cwd:/a"); f.attach(a); const view = f.guest(a);
  assert.deepEqual(view.popup({ url: "https://example.com/next" }), { action: "deny" });
  assert.deepEqual(f.messages, [[IPC.openRequested, { lease: a.lease, url: "https://example.com/next" }]]);
  const blocked = ["http://localhost:4251/x", "ws://127.0.0.1:4251", "http://[::1]:4251", "https://user:pass@example.com", "file:///tmp/a", "vscode://file/a", "javascript:alert(1)"];
  for (const url of blocked) {
    view.popup({ url });
    const event = { isMainFrame: true, url, prevented: false, preventDefault() { this.prevented = true; } };
    view.emit("will-frame-navigate", event);
    assert.equal(event.prevented, true, url);
    const storage = f.sessions.get(a.partition); let cancel;
    storage.request({ url }, result => { cancel = result.cancel; });
    assert.equal(cancel, true, url);
  }
  view.popup({ url: "https://example.com/post", postBody: {} });
  assert.equal(f.messages.length, 1);
  assert.equal(f.external.length, 0);
  f.binding.dispose();
});

test("only persistent guests can use trusted link extensions; permissions remain separated from native Browser", () => {
  const f = fixture();
  for (const workspace of ["cwd:/a", PERSISTENT_BROWSER_WORKSPACE]) {
    const a = f.invoke(IPC.acquire, workspace); f.attach(a); const view = f.guest(a), storage = f.sessions.get(a.partition);
    const persistent = workspace === PERSISTENT_BROWSER_WORKSPACE;
    assert.equal(storage.check(null, "clipboard-sanitized-write", "https://example.com", {}), persistent);
    assert.equal(storage.check(null, "clipboard-read", "https://example.com", {}), false);
    assert.equal(storage.check(null, "clipboard-sanitized-write", "http://example.com", {}), false);
    assert.equal(storage.device({}), false);
    const event = { sender: view, senderFrame: view.mainFrame };
    f.ipc.emit(TABS_WEB_EXTERNAL_LINK_CHANNEL, { ...event, senderFrame: {} }, "vscode://file/subframe");
    f.ipc.emit(TABS_WEB_EXTERNAL_LINK_CHANNEL, event, "vscode://file/a");
    f.ipc.emit(TABS_WEB_EXTERNAL_LINK_CHANNEL, event, "https://example.com/link");
    assert.equal(f.external.length, persistent ? 1 : 0);
    assert.equal(f.messages.length, persistent ? 1 : 0);
  }
  f.binding.dispose();
});

test("agent-owned guests keep their independent admission and input lifetime", () => {
  const f = fixture();
  f.agentBrowser.secureWebview = () => "rejected";
  assert.equal(f.attach({ lease: "agent", partition: "agent" }).event.prevented, true);
  f.agentBrowser.secureWebview = () => "secured";
  const prefs = { agent: true };
  assert.equal(f.attach({ lease: "agent", partition: "agent" }, prefs).event.prevented, false);
  assert.deepEqual(prefs, { agent: true });
  f.agentBrowser.attachGuest = () => true;
  const view = f.guest({ lease: "agent", partition: "agent" });
  assert.equal(view.destroyed, false);
  view.close({ waitForBeforeUnload: false });
  assert.deepEqual(f.inputs, [["attach", "minke-guest-13"], ["dispose", "minke-guest-13"]]);
  f.binding.dispose();
});

test("preload uses the standard invoke contract and one lease-scoped event listener with cleanup", async () => {
  const calls = [], received = [];
  const ipc = Object.assign(new EventEmitter(), { invoke: async (...args) => { calls.push(args); return { lease: "a", partition: "a" }; } });
  const { browser, dispose } = createDesktopBrowserBridge(ipc);
  assert.deepEqual(await browser.acquire("cwd:/a"), { lease: "a", partition: "a" });
  await browser.release("a");
  assert.deepEqual(calls, [[IPC.acquire, "cwd:/a"], [IPC.release, "a"]]);
  const off = browser.onOpenRequested("a", url => received.push(url));
  browser.onOpenRequested("b", () => assert.fail("foreign lease callback"));
  assert.equal(ipc.listenerCount(IPC.openRequested), 1);
  ipc.emit(IPC.openRequested, {}, { lease: "a", url: "https://example.com" });
  ipc.emit(IPC.openRequested, {}, { lease: "a", url: 42 });
  off(); ipc.emit(IPC.openRequested, {}, { lease: "a", url: "https://example.com/ignored" });
  assert.deepEqual(received, ["https://example.com"]);
  dispose(); assert.equal(ipc.listenerCount(IPC.openRequested), 0);
});

function rendererFixture({ delayed = false, allowPopups = true } = {}) {
  const view = Object.assign(new EventTarget(), { attributes: {}, removed: false, historyCleared: 0,
    setAttribute(name, value) { this.attributes[name] = value; }, remove() { this.removed = true; },
    clearHistory() { this.historyCleared++; }, loadURL: async url => { loaded.push(url); } });
  const loaded = [], opened = [], errors = [], releases = [], acquired = [], appended = [];
  let resolve, callback, unsubscribed = 0, ready = 0;
  const pending = new Promise(done => { resolve = done; });
  const reservation = { lease: "fixture-lease", partition: "persist:minke-tabs-web" };
  const bridge = { protocolVersion: 1, browser: {
    acquire: async workspace => { acquired.push(workspace); return delayed ? pending : reservation; },
    release: async id => { releases.push(id); },
    onOpenRequested: (_id, handler) => { callback = handler; return () => { unsubscribed++; }; },
  } };
  const dispose = mountPersistentBrowser({ append: view => appended.push(view) }, view, {
    label: "Persistent Browser", allowPopups,
    ready: () => { ready++; void view.loadURL("https://example.com/latest"); }, openRequested: url => opened.push(url), failed: error => errors.push(error),
  }, bridge);
  return { view, loaded, opened, errors, releases, acquired, appended, dispose,
    resolve: () => resolve(reservation), open: url => callback(url), counters: () => ({ ready, unsubscribed }) };
}

test("persistent renderer waits for approved bootstrap, clears initial history and releases once", async () => {
  const f = rendererFixture(); await until(() => f.appended.length === 1);
  assert.deepEqual(f.acquired, [PERSISTENT_BROWSER_WORKSPACE]);
  assert.equal(f.view.attributes.src, "about:blank#fixture-lease");
  assert.equal(f.view.attributes.name, "fixture-lease");
  assert.equal(f.view.attributes.partition, "persist:minke-tabs-web");
  assert.equal(f.view.attributes.allowpopups, "");
  assert.deepEqual(f.loaded, []);
  f.view.dispatchEvent(new Event("dom-ready")); f.view.dispatchEvent(new Event("dom-ready"));
  assert.deepEqual(f.loaded, ["https://example.com/latest"]);
  f.view.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "about:blank#fixture-lease" }));
  assert.equal(f.view.historyCleared, 0);
  for (let i = 0; i < 2; i++) f.view.dispatchEvent(Object.assign(new Event("did-navigate"), { url: "https://example.com/latest" }));
  assert.equal(f.view.historyCleared, 1);
  f.open("https://example.com/open"); assert.equal(f.opened.length, 1);
  f.dispose(); f.dispose(); f.open("https://example.com/ignored");
  assert.equal(f.opened.length, 1); assert.equal(f.view.removed, true);
  assert.deepEqual(f.releases, ["fixture-lease"]);
  assert.deepEqual(f.counters(), { ready: 1, unsubscribed: 1 });
});

test("unmount during acquire releases the late lease; plugin discovery disables popups and guest loss cleans up", async () => {
  const late = rendererFixture({ delayed: true }); late.dispose(); late.resolve();
  await until(() => late.releases.length === 1);
  assert.equal(late.appended.length, 0);
  const discovery = rendererFixture({ allowPopups: false }); await until(() => discovery.appended.length === 1);
  assert.equal(discovery.view.attributes.allowpopups, undefined);
  discovery.view.dispatchEvent(new Event("render-process-gone"));
  assert.equal(discovery.errors.length, 1); assert.equal(discovery.releases.length, 1);
  assert.equal(discovery.counters().unsubscribed, 1);
});
