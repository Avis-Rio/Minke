"use strict";

// Two independent Electron processes share only a temporary profile. The first
// seeds the old partition; the second proves login compatibility after restart.
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { buildSync } = require("esbuild");
const { closeServer } = require("./support/http-server.cjs");
const projectRoot = join(__dirname, "..");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function orchestrate() {
  const root = mkdtempSync(join(tmpdir(), "minke-browser-leases-"));
  const site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    res.end('<!doctype html><title>Browser fixture</title><input id="draft" value="retained">');
  });
  try {
    const origin = await listen(site);
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    for (const phase of ["seed", "restart"]) {
      const child = spawn(require("electron"), [__filename, root, origin, phase], {
        cwd: projectRoot, stdio: "inherit", env: environment,
      });
      const timer = setTimeout(() => child.kill("SIGTERM"), 45_000);
      const [code, signal] = await once(child, "exit");
      clearTimeout(timer);
      assert.equal(code, 0, `${phase} Electron process failed (${signal ?? code})`);
    }
    console.log("DSH native Browser and persistent login restart regression passed");
  } finally {
    if (site.listening) await closeServer(site);
    rmSync(root, { recursive: true, force: true });
  }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, session } = require("electron");
  app.on("web-contents-created", (_event, contents) => {
    contents.on("console-message", event => {
      if (event.level === "error") console.error(`[browser renderer ${contents.id}] ${event.message}`);
    });
  });
  const [root, site, phase] = process.argv.slice(2);
  mkdirSync(join(root, "profile"), { recursive: true });
  app.setPath("userData", join(root, "profile"));
  app.on("window-all-closed", () => {});
  const bundle = join(root, "browser-guests.cjs");
  buildSync({ entryPoints: [join(projectRoot, "desktop/main/browser-guests.ts")], bundle: true,
    external: ["electron"], platform: "node", format: "cjs", outfile: bundle });
  const { DesktopBrowserGuests } = require(bundle);
  const client = buildSync({ stdin: { resolveDir: projectRoot, loader: "ts", contents: `
    import { createElectronPage } from './vendor/deepseek-harness/packages/client/ui-sidebar-browser/src/client/electron/pages.ts';
    import { parseBrowserAddress } from './vendor/deepseek-harness/packages/client/ui-sidebar-browser/src/client/browser/url.ts';
    import { mountPersistentBrowser } from './packages/harness-overlay/src/client/tabs/web/guest.ts';
    const opened = [], errors = [], pages = new Map();
    window.browserFixture = {
      opened, errors,
      native(id, url, workspace = 'cwd:/fixture') {
        const host = document.createElement('div'); host.id = id; document.body.append(host);
        const page = createElectronPage({ initial: undefined, persist() {}, openRequested: url => opened.push(url) },
          window.dshDesktop.browser, async () => workspace);
        page.presentation.mount(id);
        page.frame.loadUrl(parseBrowserAddress(url).target);
        pages.set(id, page);
      },
      persistent(id, url) {
        const host = document.createElement('div'); host.id = id; document.body.append(host);
        const view = document.createElement('webview');
        const dispose = mountPersistentBrowser(host, view, { label: 'Persistent Browser', allowPopups: true,
          ready() { void view.loadURL(url); }, openRequested: url => opened.push(url), failed: error => errors.push(String(error)) });
        pages.set(id, { frame: { dispose } });
      },
      dispose: id => pages.get(id).frame.dispose(),
      state: id => pages.get(id).frame.getSnapshot(),
      webContentsId: id => {
        try { return document.querySelector('#' + id + ' webview')?.getWebContentsId(); }
        catch { return undefined; } // Native guest creation is asynchronous.
      },
    };
  ` }, bundle: true, platform: "browser", format: "iife", loader: { ".css": "local-css" },
    tsconfig: join(projectRoot, "tsconfig.json"),
    outfile: join(root, "client.js"), write: false }).outputFiles.find(file => file.path.endsWith(".js")).text;
  let blockedHostRequests = 0;
  const host = createServer((req, res) => {
    if (req.url === "/blocked") blockedHostRequests++;
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>DSH Host fixture</title><style>webview{display:flex;width:500px;height:200px}</style>');
  });
  host.on("upgrade", (_req, socket) => { blockedHostRequests++; socket.destroy(); });
  const windows = [], guests = new Map();
  let binding;
  async function waitFor(predicate, label) {
    const until = Date.now() + 8_000;
    while (!(await predicate())) {
      if (Date.now() > until) throw new Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try {
    await app.whenReady();
    const hostOrigin = await listen(host);
    if (phase === "seed") {
      const legacy = new BrowserWindow({ show: false, webPreferences: { partition: "persist:minke-tabs-web", sandbox: true } });
      windows.push(legacy);
      await legacy.loadURL(site);
      await legacy.webContents.executeJavaScript("localStorage.setItem('login', 'legacy-login'); document.cookie = 'login=legacy-cookie; Max-Age=86400; SameSite=Lax'");
      await legacy.webContents.session.cookies.flushStore();
      legacy.webContents.session.flushStorageData();
      legacy.destroy();
    }
    const window = new BrowserWindow({ show: false, webPreferences: {
      preload: join(projectRoot, ".vite/build/desktop-preload.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: true,
    } });
    windows.push(window);
    window.webContents.on("did-attach-webview", (_event, guest) => guests.set(guest.id, guest));
    const manager = new DesktopBrowserGuests({ harnessUrl: () => hostOrigin,
      preload: join(projectRoot, ".vite/build/tabs-web-preload.js"),
      external: { openExternal: async () => assert.fail("native Browser must use its source-tab callback") } });
    binding = manager.bind(ipcMain, window.webContents, event => new URL(event.senderFrame.url).origin === hostOrigin);
    await window.loadURL(hostOrigin);
    await window.webContents.executeJavaScript(client);
    const evaluate = code => window.webContents.executeJavaScript(code).catch(error => { throw new Error(`${code}: ${error.message}`); });
    const open = async (kind, id, workspace) => {
      await evaluate(`browserFixture.${kind}(${JSON.stringify(id)}, ${JSON.stringify(site)}, ${JSON.stringify(workspace)})`);
      let guest;
      await waitFor(async () => {
        const idValue = await evaluate(`browserFixture.webContentsId(${JSON.stringify(id)})`);
        guest = guests.get(idValue);
        return guest && guest.getURL() === site + "/" && !guest.isLoading();
      }, `loaded ${kind} guest ${id}`);
      return guest;
    };
    const native = await open("native", "native");
    assert.equal(await native.executeJavaScript("localStorage.getItem('ordinary')"), null, "ordinary Browser storage must not survive a process restart");
    assert.equal(await native.executeJavaScript("localStorage.getItem('login')"), null);
    assert.equal(await native.executeJavaScript("document.cookie"), "");
    await native.executeJavaScript("localStorage.setItem('ordinary', 'this-process')");
    const peer = await open("native", "peer");
    assert.equal(peer.session, native.session, "same workspace shares its temporary account");
    assert.equal(await peer.executeJavaScript("localStorage.getItem('ordinary')"), "this-process");
    const other = await open("native", "other", "cwd:/other");
    assert.notEqual(other.session, native.session);
    assert.equal(await other.executeJavaScript("localStorage.getItem('ordinary')"), null);
    const persistent = await open("persistent", "persistent");
    assert.equal(persistent.session, session.fromPartition("persist:minke-tabs-web"));
    assert.equal(await persistent.executeJavaScript("localStorage.getItem('login')"), "legacy-login");
    assert.equal(await persistent.executeJavaScript("document.cookie"), "login=legacy-cookie");
    assert.equal(await persistent.executeJavaScript("localStorage.getItem('ordinary')"), null);
    assert.equal(native.getLastWebPreferences().sandbox, true);
    assert.equal(native.getLastWebPreferences().nodeIntegration, false);
    assert.deepEqual(await persistent.executeJavaScript("[typeof require, typeof process, typeof dshDesktop, typeof minkeDesktop]"),
      ["undefined", "undefined", "undefined", "undefined"], "trusted preload never exposes desktop capabilities to the website");
    assert.equal((await evaluate("browserFixture.state('native')")).canGoBack, false, "bootstrap is not a Back entry");
    await native.executeJavaScript(`window.open(${JSON.stringify(site + "/popup")}, '_blank')`);
    await waitFor(async () => (await evaluate("browserFixture.opened")).length === 1, "native source-tab popup callback");
    assert.deepEqual(await evaluate("browserFixture.opened"), [site + "/popup"]);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(await native.executeJavaScript(`fetch(${JSON.stringify(hostOrigin + "/blocked")}).then(() => 'allowed', () => 'blocked')`), "blocked");
    assert.equal(await native.executeJavaScript(`new Promise(resolve => { const ws = new WebSocket(${JSON.stringify(hostOrigin.replace("http:", "ws:") + "/blocked")}); ws.onerror = () => resolve('blocked'); ws.onopen = () => { ws.close(); resolve('allowed'); }; })`), "blocked");
    assert.equal(blockedHostRequests, 0);
    await evaluate("browserFixture.dispose('persistent')");
    await waitFor(() => persistent.isDestroyed(), "persistent close releases guest");
    const reopened = await open("persistent", "reopened");
    assert.equal(await reopened.executeJavaScript("localStorage.getItem('login')"), "legacy-login");
    await evaluate("browserFixture.dispose('native')");
    await waitFor(() => native.isDestroyed(), "native close releases guest");
    assert.equal(peer.isDestroyed(), false, "releasing one lease preserves its workspace peers");
    assert.deepEqual(await evaluate("browserFixture.errors"), []);
    await window.loadURL(hostOrigin + "/reload");
    await waitFor(() => [...guests.values()].every(guest => guest.isDestroyed()), "Host reload releases all owned leases");
    await session.fromPartition("persist:minke-tabs-web").cookies.flushStore();
    session.fromPartition("persist:minke-tabs-web").flushStorageData();
    console.log(`Browser guest ${phase} phase passed`);
  } finally {
    binding?.dispose();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    if (host.listening) await closeServer(host);
  }
}

if (process.versions.electron) {
  runElectron().then(() => require("electron").app.exit(0), error => { console.error(error); require("electron").app.exit(1); });
} else {
  orchestrate().catch(error => { console.error(error); process.exitCode = 1; });
}
