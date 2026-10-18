"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { buildSync } = require("esbuild");

const projectRoot = join(__dirname, "..");
const root = mkdtempSync(join(tmpdir(), "minke-desktop-platform-"));
mkdirSync(join(root, "user-data"));
app.setPath("userData", join(root, "user-data"));
app.on("window-all-closed", () => {});
let window;
let phase = "build fixtures";
const disposers = [];
const deadline = setTimeout(() => { console.error(`Desktop platform regression timed out: ${phase}`); finish(1); }, 45_000);

async function waitFor(predicate, label) {
  const until = Date.now() + 8_000;
  while (!(await predicate())) {
    if (Date.now() >= until) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function run() {
  const mainBundle = join(root, "platform.cjs");
  buildSync({ tsconfig: join(projectRoot, "tsconfig.json"), stdin: { resolveDir: projectRoot, contents: `
    export { bindWindowFullscreen } from './desktop/main/window-fullscreen.ts';
    export { bindDirectoryPickerIpc } from './desktop/main/directory-picker.ts';
    export { bindDataHomeSettingsIpc } from './desktop/main/data-home-settings.ts';
    export { macOSWindowOptions } from './desktop/main/macos-window.ts';
  ` }, bundle: true, format: "cjs", platform: "node", outfile: mainBundle });
  const { bindWindowFullscreen, bindDirectoryPickerIpc, bindDataHomeSettingsIpc, macOSWindowOptions } = require(mainBundle);
  const client = buildSync({ tsconfig: join(projectRoot, "tsconfig.json"), stdin: { resolveDir: projectRoot, contents: `
    import { desktopDataHomeSettingsPort } from './packages/harness-overlay/src/client/desktop/settings.ts';
    window.storage = desktopDataHomeSettingsPort();
  ` }, bundle: true, format: "iife", platform: "browser", write: false }).outputFiles[0].text;
  const nativeCss = buildSync({ tsconfig: join(projectRoot, "tsconfig.json"),
    entryPoints: [join(projectRoot, "vendor/deepseek-harness/packages/client/ui-layout/src/client/AppFrame.module.css")],
    bundle: true, write: false,
  }).outputFiles[0].text;
  const html = `<!doctype html><title>Desktop platform regression</title><style>${nativeCss}
    #overlay { position: absolute; top: var(--dsh-frame-overlay-top); }
    </style><div id="overlay">Storage and fullscreen regression</div>
    <script>${client.replaceAll("</script>", "<\\/script>")}</script>`;
  phase = "Electron ready";
  await app.whenReady();
  window = new BrowserWindow({ show: true, width: 720, height: 480,
    ...macOSWindowOptions(),
    webPreferences: { preload: join(projectRoot, ".vite/build/desktop-preload.js"),
      nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  if (process.platform === "darwin") {
    assert.equal(window.getWindowButtonPosition(), null, "traffic lights use the native default position");
  }
  const contents = window.webContents;
  const evaluate = source => contents.executeJavaScript(source);
  const authorize = event => event.sender === contents && event.senderFrame === contents.mainFrame;
  let selection = { canceled: false, filePaths: [join(root, "数据目录")] };
  let picks = 0;
  const picker = bindDirectoryPickerIpc(ipcMain, {
    currentWindow: () => window, authorize,
    async showOpenDialog(owner, options) {
      assert.equal(owner, window);
      assert.deepEqual(options, { properties: ["openDirectory", "createDirectory"] });
      picks++;
      return selection;
    },
  });
  const data = { activePath: join(root, "active"), recommendedPath: join(root, "recommended"), candidates: [] };
  const migration = bindDataHomeSettingsIpc(ipcMain, {
    async read() { return data; },
    async plan() { assert.fail("Selection must not plan a migration"); },
    async schedule() { assert.fail("Selection must not schedule a migration"); },
  }, authorize);
  disposers.push(() => picker.dispose(), () => migration.dispose(), bindWindowFullscreen(window));
  phase = "page load";
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  phase = "Storage selection";
  console.log("[desktop-platform] page loaded");
  assert.equal(await evaluate("typeof window.minkeDesktop.dataHome.chooseDirectory"), "undefined");
  assert.deepEqual(await evaluate("window.storage.read()"), data);
  assert.equal(await evaluate("window.storage.chooseDirectory()"), selection.filePaths[0]);
  selection = { canceled: true, filePaths: [] };
  assert.equal(await evaluate("window.storage.chooseDirectory()"), undefined);
  assert.equal(await evaluate("window.__DSH_DIRECTORY_PICKER__.pick()"), null);
  assert.equal(picks, 3);
  assert.deepEqual(await evaluate("window.storage.read()"), data);

  console.log("[desktop-platform] shared Storage picker passed");
  if (process.platform === "darwin" || process.platform === "win32") {
    const marked = () => evaluate("document.documentElement.getAttribute('data-fullscreen')");
    const overlayTop = () => evaluate("getComputedStyle(document.querySelector('#overlay')).top");
    assert.equal(await marked(), null);
    if (process.platform === "darwin") assert.equal(await overlayTop(), "68px");
    const entered = once(window, "enter-full-screen");
    phase = "enter fullscreen";
    window.setFullScreen(true);
    await entered;
    await waitFor(async () => await marked() === "true", "fullscreen marker");
    if (process.platform === "darwin") assert.equal(await overlayTop(), "20px");
    const loaded = once(contents, "did-finish-load");
    phase = "reload in fullscreen";
    contents.reload();
    await loaded;
    await waitFor(async () => await marked() === "true", "fullscreen state after reload");
    if (process.platform === "darwin") assert.equal(await overlayTop(), "20px");
    const left = once(window, "leave-full-screen");
    phase = "leave fullscreen";
    window.setFullScreen(false);
    await left;
    await waitFor(async () => await marked() === null, "windowed marker removal");
    if (process.platform === "darwin") assert.equal(await overlayTop(), "68px");
  }
  console.log("Desktop platform runtime passed: shared Storage picker, cancellation, private picker removal, fullscreen transitions, reload and native layout clearance");
}

function finish(code) {
  clearTimeout(deadline);
  for (const dispose of disposers.reverse()) dispose();
  if (window && !window.isDestroyed()) window.destroy();
  rmSync(root, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0), error => { console.error(error); finish(1); });
