import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bindDesktopUpdates } from "@minke/desktop/main/desktop-updates.ts";
import { createDesktopUpdatesBridge } from "@minke/desktop/preload/updates.ts";
import { DESKTOP_UPDATE_IPC } from "@minke/harness-overlay/shared-updates-contract.ts";
import { DesktopUpdateSource } from "../vendor/deepseek-harness/packages/client/ui-settings-general/src/client/desktop-update-source.ts";

const settle = () => new Promise(resolve => setImmediate(resolve));

function transport(source) {
  const handlers = new Map(), renderer = new EventEmitter();
  const authorized = {};
  const binding = bindDesktopUpdates({
    handle(channel, handler) { handlers.set(channel, handler); },
    removeHandler(channel) { handlers.delete(channel); },
  }, source, event => event === authorized);
  renderer.invoke = async (channel, ...args) => handlers.get(channel)(authorized, ...args);
  const { updates, dispose } = createDesktopUpdatesBridge(renderer);
  return { handlers, renderer, updates, binding, dispose,
    push: value => renderer.emit(DESKTOP_UPDATE_IPC.changed, {}, value),
  };
}

test("standard update status and subscriptions feed DSH's native observation, including a late initial reply", async () => {
  let resolveStatus;
  const t = transport({ status: () => new Promise(resolve => { resolveStatus = resolve; }), async open() {} });
  const source = new DesktopUpdateSource(t.updates);
  try {
    assert.equal(t.renderer.listenerCount(DESKTOP_UPDATE_IPC.changed), 1);
    t.push({ phase: "downloading", version: "9.0.0", percent: 42 });
    resolveStatus({ phase: "idle" });
    await settle();
    assert.deepEqual(source.store.getSnapshot(), {
      failed: false, opening: false, presentation: { phase: "downloading", version: "9.0.0", percent: 42 },
    }, "initial status must not overwrite a newer main-process event");
    t.push({ phase: "error", failure: "download", version: "9.0.0" });
    assert.equal(source.store.getSnapshot().presentation.failure, "download");
    source.dispose();
    t.push({ phase: "available", version: "9.0.0" });
    assert.equal(source.store.getSnapshot().presentation.phase, "error");
  } finally { source.dispose(); t.dispose(); t.binding.dispose(); }
  assert.equal(t.renderer.listenerCount(DESKTOP_UPDATE_IPC.changed), 0);
  assert.equal(t.handlers.size, 0);
});

test("standard open coalesces callers, accepts no renderer update decisions and recovers after failure", async () => {
  const calls = [];
  let release;
  const t = transport({
    status: () => ({ phase: "idle" }),
    open(...args) { calls.push(args); return new Promise((resolve, reject) => { release = { resolve, reject }; }); },
  });
  try {
    const first = t.updates.open();
    const second = t.renderer.invoke(DESKTOP_UPDATE_IPC.open, { url: "https://untrusted.invalid/installer", install: true });
    assert.deepEqual(calls, [[]]);
    release.reject(new Error("offline fixture"));
    const results = await Promise.allSettled([first, second]);
    assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
    assert.match(results[0].reason.message, /offline fixture/u);
    const retry = t.updates.open();
    assert.equal(calls.length, 2);
    release.resolve();
    await retry;
    assert.deepEqual(await t.updates.status(), { phase: "idle" });
  } finally { t.dispose(); t.binding.dispose(); }
});

test("untrusted callers cannot read update state or start the native flow", async () => {
  let reads = 0, opens = 0;
  const t = transport({ status() { reads++; return { phase: "idle" }; }, async open() { opens++; } });
  try {
    for (const channel of [DESKTOP_UPDATE_IPC.status, DESKTOP_UPDATE_IPC.open]) {
      await assert.rejects(async () => t.handlers.get(channel)({ sender: "foreign-webview" }), /unauthorized/u);
    }
    assert.equal(reads, 0);
    assert.equal(opens, 0);
  } finally { t.dispose(); t.binding.dispose(); }
});

test("one observer cannot break other subscribers, and unsubscribe stops delivery", () => {
  const t = transport({ status: () => ({ phase: "idle" }), async open() {} });
  const values = [];
  const broken = t.updates.subscribe(() => { throw new Error("observer fixture"); });
  const unsubscribe = t.updates.subscribe(value => values.push(value));
  try {
    t.push({ phase: "checking" });
    broken();
    unsubscribe();
    t.push({ phase: "available", version: "9.0.0" });
    assert.deepEqual(values, [{ phase: "checking" }]);
  } finally { t.dispose(); t.binding.dispose(); }
});
