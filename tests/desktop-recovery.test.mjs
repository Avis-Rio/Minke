import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopQuitConfirmation } from "@minke/desktop/main/quit-confirmation.ts";
import { DesktopFatalRecovery } from "@minke/desktop/main/fatal-recovery.ts";
import { RendererConsoleTail, writeDesktopCrashReport, formatDesktopFailure } from "@minke/desktop/main/crash-report.ts";
import { bindWindowDiagnostics } from "@minke/desktop/main/window-diagnostics.ts";

const flush = () => new Promise(resolve => setImmediate(resolve));
const text = key => key;

test("idle exits skip confirmation; active, queued and scheduled work choose the right prompt", async () => {
  for (const [inspection, expected] of [
    [undefined, undefined],
    [{ activeTasks: false, scheduledTasks: false }, undefined],
    [{ activeTasks: true, scheduledTasks: false }, "quit.active"],
    [{ activeTasks: false, scheduledTasks: true }, "quit.scheduled"],
    [{ activeTasks: true, scheduledTasks: true }, "quit.activeAndScheduled"],
  ]) {
    const shown = [];
    const confirmation = new DesktopQuitConfirmation({
      inspect: () => inspection === undefined ? undefined : Promise.resolve(inspection), text, focus() {},
      show: async options => { shown.push(options); return { response: 1 }; },
    });
    assert.equal(await confirmation.confirm(), expected === undefined);
    assert.deepEqual(shown.map(options => options.detail), expected === undefined ? [] : [expected]);
  }
});

test("repeated quits share one decision; cancelling leaves a later quit usable", async () => {
  const decision = Promise.withResolvers();
  let inspections = 0;
  let dialogs = 0;
  let focused = 0;
  const confirmation = new DesktopQuitConfirmation({
    inspect: async () => { inspections++; throw new Error("Host unresponsive"); }, text,
    focus: () => { focused++; },
    show: options => {
      dialogs++;
      assert.equal(options.detail, "quit.unknown");
      return dialogs === 1 ? decision.promise : Promise.resolve({ response: 0 });
    },
  });
  const first = confirmation.confirm();
  assert.equal(confirmation.confirm(), first);
  await flush();
  assert.equal(dialogs, 1);
  assert.equal(focused, 1);
  decision.resolve({ response: 1 });
  assert.equal(await first, false);
  assert.equal(await confirmation.confirm(), true);
  assert.equal(inspections, 2);
});

test("a requested restart uses restart wording before interrupting work", async () => {
  const confirmation = new DesktopQuitConfirmation({
    inspect: async () => ({ activeTasks: true, scheduledTasks: false }), text, focus() {},
    show: async options => {
      assert.equal(options.message, "quit.restartTitle");
      assert.deepEqual(options.buttons, ["runtime.restart", "quit.cancel"]);
      return { response: 1 };
    },
  });
  assert.equal(await confirmation.confirm("restart"), false);
});

test("shutdown or fatal recovery invalidates late quit decisions", async () => {
  for (const boundary of ["inspection", "dialog"]) {
    const inspection = Promise.withResolvers();
    const decision = Promise.withResolvers();
    let shown = 0;
    const confirmation = new DesktopQuitConfirmation({
      inspect: () => inspection.promise, text, focus() {},
      show: () => { shown++; return decision.promise; },
    });
    const pending = confirmation.confirm();
    if (boundary === "dialog") {
      inspection.resolve({ activeTasks: true, scheduledTasks: false });
      await flush();
    }
    confirmation.dispose();
    inspection.resolve({ activeTasks: true, scheduledTasks: false });
    decision.resolve({ response: 0 });
    assert.equal(await pending, false);
    assert.equal(shown, boundary === "dialog" ? 1 : 0);
    assert.equal(await confirmation.confirm(), false);
  }
});

test("a cancelled system shutdown can invalidate its old decision and accept a fresh quit", async () => {
  const decision = Promise.withResolvers();
  let first = true;
  const confirmation = new DesktopQuitConfirmation({
    inspect: async () => ({ activeTasks: true, scheduledTasks: false }), text, focus() {},
    show: () => { if (first) { first = false; return decision.promise; } return Promise.resolve({ response: 0 }); },
  });
  const old = confirmation.confirm();
  await flush();
  confirmation.cancelPending();
  assert.equal(await confirmation.confirm(), true);
  decision.resolve({ response: 0 });
  assert.equal(await old, false);
});

test("fatal recovery coalesces errors and waits for cleanup before enabling safe mode and restarting", async () => {
  const calls = [];
  const stopped = Promise.withResolvers();
  const recovery = new DesktopFatalRecovery({
    text, writeReport: async () => { calls.push("report"); return "/report.log"; },
    show: async options => { calls.push("dialog"); assert.match(options.detail, /broken/u); return { response: 2 }; },
    stop: () => { calls.push("stop"); return stopped.promise; },
    canEnableSafeMode: () => true,
    enableSafeMode: async () => { calls.push("safe-mode"); },
    restart: () => { calls.push("restart"); }, exit: () => { calls.push("exit"); },
  });
  const pending = recovery.report(new Error("broken"), "renderer");
  await recovery.report(new Error("duplicate"), "host");
  await flush();
  assert.deepEqual(calls, ["report", "dialog", "stop"]);
  stopped.resolve();
  await pending;
  assert.deepEqual(calls, ["report", "dialog", "stop", "safe-mode", "restart"]);
});

test("recovery handles failed cleanup and bounded diagnostics without losing the exit action", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const shown = [];
  let exit = false;
  const recovery = new DesktopFatalRecovery({
    text, writeReport: () => new Promise(() => {}),
    show: async options => { shown.push(options); return { response: shown.length === 1 ? 0 : 1 }; },
    stop: async () => { throw new Error("cleanup failed"); },
    canEnableSafeMode: () => false,
    enableSafeMode: async () => { throw new Error("not available"); },
    restart: () => { throw new Error("must not restart after failed cleanup"); },
    exit: () => { exit = true; },
  });
  const pending = recovery.report(new Error("broken"), "startup");
  t.mock.timers.tick(1_000);
  await pending;
  assert.equal(shown.length, 2);
  assert.equal(shown[1].message, "recovery.failed");
  assert.deepEqual(shown[0].buttons, ["runtime.restart", "runtime.quit"]);
  assert.equal(exit, true);
});

test("disposal prevents a late recovery dialog", async () => {
  const persisted = Promise.withResolvers();
  const recovery = new DesktopFatalRecovery({
    text, writeReport: () => persisted.promise,
    show: () => { throw new Error("must not show during quit"); },
  });
  const pending = recovery.report(new Error("broken"), "host");
  recovery.dispose();
  persisted.resolve("/report.log");
  await pending;
});

test("private diagnostics retain cause chains, redact launch tokens and prune only owned reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-diagnostics-"));
  try {
    await writeFile(join(root, "keep.log"), "keep");
    const consoleTail = new RendererConsoleTail();
    consoleTail.append("x".repeat(70_000));
    consoleTail.append("load http://127.0.0.1/?token=secret");
    assert.ok(consoleTail.snapshot().length <= 64 * 1024 + 10);
    const failure = new Error("boot failed", { cause: new Error("http://127.0.0.1/?token=secret") });
    const diagnostic = formatDesktopFailure(failure);
    assert.match(diagnostic, /cause/u);
    assert.match(diagnostic, /<redacted>/u);
    assert.doesNotMatch(diagnostic, /secret/u);
    let path;
    for (let day = 1; day <= 12; day++) path = await writeDesktopCrashReport(root,
      failure,
      "host", consoleTail.snapshot(), "test", new Date(Date.UTC(2026, 9, day)));
    const report = await readFile(path, "utf8");
    assert.equal(report.split("\n\n")[1], diagnostic);
    assert.deepEqual(report.split("\n").slice(0, 3), ["Minke test", "time: 2026-10-12T00:00:00.000Z", "source: host"]);
    assert.equal(report.endsWith("load http://127.0.0.1/?token=<redacted>\n\n"), true);
    assert.equal((await readdir(root)).length, 11);
    assert.equal(await readFile(join(root, "keep.log"), "utf8"), "keep");
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("main-window diagnostics ignore subframes, aborted navigations and clean exits", () => {
  const contents = new EventEmitter();
  const errors = [];
  const consoleErrors = [];
  const dispose = bindWindowDiagnostics(contents, error => errors.push(error.message), value => consoleErrors.push(value));
  contents.emit("did-fail-load", {}, -3, "aborted", "secret-url", true);
  contents.emit("did-fail-load", {}, -2, "failed", "secret-url", false);
  contents.emit("render-process-gone", {}, { reason: "clean-exit" });
  assert.equal(errors.length, 0);
  contents.emit("did-fail-load", {}, -2, "failed", "secret-url", true);
  contents.emit("preload-error", {}, "/preload", new Error("preload failed"));
  contents.emit("render-process-gone", {}, { reason: "crashed" });
  assert.equal(errors.length, 3);
  assert.equal(errors.some(message => message.includes("secret-url")), false);
  contents.emit("console-message", { level: "error", sourceId: "app", lineNumber: 3, message: "broken" });
  assert.deepEqual(consoleErrors, ["app:3 broken"]);
  dispose();
  assert.equal(contents.eventNames().length, 0);
});

test("shutdown reports retain failure phase and concurrent failures in the same millisecond", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-shutdown-report-"));
  try {
    const time = new Date("2026-10-02T12:00:00.000Z");
    const paths = await Promise.all(["first", "second"].map(message => writeDesktopCrashReport(root,
      new Error(`${message} http://localhost/?token=private`), "host", "", "test", time, "shutdown")));
    assert.equal(new Set(paths).size, 2);
    const reports = await Promise.all(paths.map(path => readFile(path, "utf8")));
    for (const [index, report] of reports.entries()) {
      const [header, failureSection] = report.split("\n\n");
      const metadata = Object.fromEntries(header.split("\n").slice(1).map(line => {
        const separator = line.indexOf(": ");
        return [line.slice(0, separator), line.slice(separator + 2)];
      }));
      assert.equal(metadata.phase, "shutdown");
      assert.equal(failureSection.split("\n")[0], `Error: ${index === 0 ? "first" : "second"} http://localhost/?token=<redacted>`);
      assert.equal(report.includes("token=private"), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
