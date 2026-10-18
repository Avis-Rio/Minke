"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require("node:fs");
const { readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, BrowserWindow } = require("electron");
const { buildSync } = require("esbuild");

const root = mkdtempSync(join(tmpdir(), "minke-recovery-runtime-"));
mkdirSync(join(root, "user-data"));
app.setPath("userData", join(root, "user-data"));
app.on("window-all-closed", () => {});
const modules = {};
for (const name of ["window-diagnostics", "fatal-recovery", "crash-report"]) {
  const target = join(root, `${name}.cjs`);
  buildSync({ entryPoints: [join(__dirname, "..", "desktop", "main", `${name}.ts`)],
    bundle: true, format: "cjs", platform: "node", outfile: target, external: ["electron"] });
  modules[name] = require(target);
}
const { bindWindowDiagnostics } = modules["window-diagnostics"];
const { DesktopFatalRecovery } = modules["fatal-recovery"];
const { RendererConsoleTail, writeDesktopCrashReport } = modules["crash-report"];
const windows = new Set();
const deadline = setTimeout(() => { console.error("Desktop recovery runtime timed out"); finish(1); }, 30_000);

async function checkFailure(kind) {
  const preload = join(root, "broken-preload.cjs");
  writeFileSync(preload, 'throw new Error("fixture preload failure");');
  const window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true,
    ...(kind === "preload" ? { preload } : {}),
  } });
  windows.add(window);
  const consoleTail = new RendererConsoleTail();
  const completed = Promise.withResolvers();
  const operations = [];
  let reports = 0;
  let reportPath;
  const recovery = new DesktopFatalRecovery({
    text: key => key,
    writeReport: async (error, source) => {
      reports++;
      reportPath = await writeDesktopCrashReport(join(root, kind), error, source, consoleTail.snapshot(), "test");
      return reportPath;
    },
    show: async () => { operations.push("dialog"); return { response: 0 }; },
    stop: async () => { operations.push("stop"); },
    canEnableSafeMode: () => false,
    enableSafeMode: async () => { throw new Error("unexpected safe mode"); },
    restart: () => { operations.push("restart"); completed.resolve(); },
    exit: () => completed.reject(new Error("unexpected exit")),
  });
  const dispose = bindWindowDiagnostics(window.webContents,
    error => { void recovery.report(error, "renderer").catch(completed.reject); },
    value => consoleTail.append(value));
  try {
    if (kind === "load") {
      await window.loadURL(pathToFileURL(join(root, "missing.html")).href).catch(() => {});
    } else {
      await window.loadURL("data:text/html,<!doctype html><title>Recovery fixture</title>");
      if (kind === "renderer") {
        await window.webContents.executeJavaScript('console.error("fixture renderer diagnostic")');
        window.webContents.forcefullyCrashRenderer();
      }
    }
    await completed.promise;
    assert.equal(reports, 1, "one fatal error must produce one recovery report");
    assert.deepEqual(operations, ["dialog", "stop", "restart"]);
    const report = await readFile(reportPath, "utf8");
    assert.ok(report.includes(kind === "preload" ? "fixture preload failure"
      : kind === "renderer" ? "fixture renderer diagnostic" : "page failed to load"));
  } finally {
    dispose();
    window.destroy();
    windows.delete(window);
  }
}

async function run() {
  await app.whenReady();
  for (const kind of ["preload", "renderer", "load"]) await checkFailure(kind);
  console.log("Desktop recovery runtime passed: preload failure, renderer crash, main-frame load failure, persisted diagnostics, ordered restart");
}

function finish(code) {
  clearTimeout(deadline);
  for (const window of windows) if (!window.isDestroyed()) window.destroy();
  rmSync(root, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0), error => { console.error(error); finish(1); });
