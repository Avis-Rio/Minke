"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, readFileSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");

const projectRoot = join(__dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "minke-session-export-"));
mkdirSync(join(temporaryRoot, "user-data"));
app.setPath("userData", join(temporaryRoot, "user-data"));
app.on("window-all-closed", () => {});
const mainBundle = join(temporaryRoot, "downloads.cjs");
buildSync({ entryPoints: [join(projectRoot, "desktop/main/session-export/index.ts")],
  bundle: true, format: "cjs", platform: "node", outfile: mainBundle });
const { bindSessionLogExport } = require(mainBundle);
const client = buildSync({
  stdin: { resolveDir: projectRoot, contents: `
    import { Context } from '@deepseek-ai/cordis';
    import { SessionLogDownloadController } from './vendor/deepseek-harness/packages/session-query/session-log-export/src/client/controller.ts';
    import { ShortcutRegistry } from './vendor/deepseek-harness/packages/client/shortcuts/src/client/registry.ts';
    import { ShortcutRuntime } from './packages/harness-overlay/src/client/shortcuts/runtime.ts';
    import { installSessionExport } from './packages/harness-overlay/src/client/shortcuts/session-export.ts';
    const ctx = new Context();
    const controller = new SessionLogDownloadController();
    const runtime = new ShortcutRuntime(new ShortcutRegistry('desktop', 'macos'));
    let sessionId = 'runtime-session';
    ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { [sessionId]: { retainedBy: { mainView: 1 } } } }) } });
    ctx.provide('sessionLogDownload', controller);
    const overlay = ctx.plugin(scope => installSessionExport(scope, runtime, key => key));
    overlay.await().then(() => {
      window.exportFixture = {
        run: id => { sessionId = id; return runtime.invoke('session.export'); },
        state: id => controller.store.getSnapshot().bySession[id],
      };
    });
  ` },
  bundle: true, format: "iife", platform: "browser", write: false,
}).outputFiles[0].text;
const archive = Buffer.from("504b0506000000000000000000000000000000000000", "hex");
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://fixture.invalid");
  if (url.pathname === "/client.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(client);
  } else if (url.pathname === "/api/session.export") {
    requests.push({ method: request.method, url });
    if (url.searchParams.get("sessionId") === "unavailable") {
      response.writeHead(503);
      response.end();
    } else {
      response.writeHead(200, { "content-type": "application/zip", "content-length": archive.length,
        "content-disposition": 'attachment; filename="dsh-session-runtime-session.zip"' });
      response.end(request.method === "HEAD" ? undefined : archive);
    }
  } else {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<!doctype html><title>Session export regression</title><script src="/client.js"></script>');
  }
});
let window, binding;
const deadline = setTimeout(() => { console.error("Session export runtime test timed out"); finish(1); }, 25_000);

async function waitFor(predicate) {
  const until = Date.now() + 5_000;
  while (!(await predicate())) {
    if (Date.now() >= until) throw new Error("Session export renderer did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function run() {
  await app.whenReady();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(projectRoot, ".vite/build/desktop-preload.js"),
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  } });
  const revealed = [], reported = [];
  binding = bindSessionLogExport(window.webContents.session, window.webContents, {
    showItemInFolder: path => revealed.push(path),
  }, {
    harnessUrl: () => origin,
    saveDialogOptions: filename => ({ title: "Export Session log", defaultPath: join(temporaryRoot, filename) }),
    reportError: error => reported.push(error),
  });
  const completed = Promise.withResolvers();
  const destination = join(temporaryRoot, "chosen.zip");
  window.webContents.session.once("will-download", (event, item, source) => {
    try {
      assert.equal(source, window.webContents);
      assert.equal(item.getSaveDialogOptions().title, "Export Session log");
      assert.equal(item.getSaveDialogOptions().defaultPath, join(temporaryRoot, "dsh-session-runtime-session.zip"));
      // Assert the production dialog configuration, then avoid opening an OS dialog in the test.
      item.setSavePath(destination);
      item.once("done", (_event, state) => completed.resolve(state));
    } catch (error) {
      event.preventDefault();
      completed.reject(error);
    }
  });
  await window.loadURL(origin);
  await waitFor(() => window.webContents.executeJavaScript("Boolean(window.exportFixture)"));
  assert.equal(await window.webContents.executeJavaScript("Boolean(window.minkeDesktop) && !('sessionLogs' in window.minkeDesktop)"), true,
    "the production preload no longer exposes the private Session export bridge");
  assert.equal(await window.webContents.executeJavaScript("window.exportFixture.run('runtime-session')", true), true);
  assert.equal(await completed.promise, "completed");
  assert.deepEqual(readFileSync(destination), archive);
  assert.deepEqual(revealed, [destination]);
  assert.deepEqual(reported, []);
  assert.deepEqual(requests.map(request => request.method), ["HEAD", "GET"]);
  for (const { url } of requests) {
    assert.equal(url.searchParams.get("sessionId"), "runtime-session");
    assert.equal(url.searchParams.get("includeDescendants"), "true");
    assert.equal(url.searchParams.has("minkeExport"), false);
  }
  await window.webContents.executeJavaScript("window.exportFixture.run('unavailable')", true);
  await waitFor(() => window.webContents.executeJavaScript("window.exportFixture.state('unavailable')?.status === 'error'"));
  assert.deepEqual(requests.map(request => request.method), ["HEAD", "GET", "HEAD"]);
  assert.deepEqual(reported, [], "preflight failures remain in the native client UI");
  assert.deepEqual(revealed, [destination]);
  console.log("Session export runtime passed: native palette service, retired preload bridge, one HEAD/GET, ZIP save/reveal and shared failure state");
}

function finish(code) {
  clearTimeout(deadline);
  binding?.dispose();
  if (window && !window.isDestroyed()) window.destroy();
  server.close();
  rmSync(temporaryRoot, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0), error => { console.error(error); finish(1); });
