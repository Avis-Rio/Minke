import assert from "node:assert/strict";
import test from "node:test";
import { ShortcutRegistry } from "@vendor/deepseek-harness/packages/client/shortcuts/src/client/registry.ts";
import { initialShortcutConfig } from "@vendor/deepseek-harness/packages/client/shortcuts/src/protocol.ts";
import { ShortcutRuntime } from "@minke/harness-overlay/client/shortcuts/runtime.ts";
import { migrateShortcutBindings } from "@minke/desktop/main/shortcut-persistence.ts";

const context = { region: "page", modal: null, target: null };
const gesture = (code, extra = {}) => ({ code, meta: true, control: false, alt: false, shift: false,
  repeat: false, composing: false, defaultPrevented: false, ...extra });
const action = (id, run, defaultBinding = "Mod+K") => ({ id, label: () => id, defaultBinding, run });

test("Minke commands dispatch through the real DSH registry and unload with their owner", () => {
  const registry = new ShortcutRegistry("desktop", "macos");
  const runtime = new ShortcutRuntime(registry);
  let count = 0;
  const off = runtime.register(action("palette.open", () => count++));
  assert.equal(registry.dispatch(gesture("KeyK"), context, () => {}).status, "pass");
  assert.equal(registry.dispatch(gesture("KeyK", { shift: true }), context, () => {}).status, "handled");
  assert.equal(count, 1);
  registry.dispatch(gesture("KeyK", { shift: true, composing: true }), context, () => {});
  assert.equal(count, 1, "composition never invokes a product action");
  off();
  assert.equal(registry.dispatch(gesture("KeyK", { shift: true }), context, () => {}).status, "pass");
  runtime.dispose();
});

test("shared commands keep their DSH owner, labels, and bindings", () => {
  const registry = new ShortcutRegistry("desktop", "macos");
  let dsh = 0;
  registry.register({ id: "session.new", label: () => "New session", aliases: [],
    defaults: { "desktop:macos": { code: "KeyN", modifiers: ["primary"] } },
    regions: ["page"], modals: [], resolve: () => ({ status: "handled", run: () => dsh++ }) });
  const runtime = new ShortcutRuntime(registry);
  let palette = 0;
  runtime.register(action("session.new", () => palette++, "Mod+N"));
  registry.dispatch(gesture("KeyN"), context, () => {});
  assert.equal(dsh, 1);
  assert.equal(palette, 0);
  assert.equal(registry.definitions().length, 1, "no duplicate shared command");
  assert.equal(runtime.listActions()[0].binding, "Mod+N");
  runtime.invoke("session.new");
  assert.equal(palette, 1, "palette uses the existing product action");
  runtime.dispose();
  assert.equal(registry.definitions().length, 1, "unloading Minke preserves DSH commands");
});

test("remote browser sessions keep Minke actions in the shared web profile", () => {
  const registry = new ShortcutRegistry("web", "windows");
  const runtime = new ShortcutRuntime(registry);
  let count = 0;
  runtime.register(action("palette.open", () => count++));
  assert.equal(registry.dispatch(gesture("KeyK", { meta: false, control: true, shift: true }), context, () => {}).status, "handled");
  assert.equal(count, 1);
  runtime.dispose();
});

test("legacy overrides and explicit unbinding drive palette and key dispatch from the same accepted catalog", () => {
  const registry = new ShortcutRegistry("desktop", "macos");
  const runtime = new ShortcutRuntime(registry);
  let count = 0;
  runtime.register({ ...action("palette.open", () => count++), palette: { group: "application" } });
  const document = migrateShortcutBindings({ "palette.open": "Mod+Shift+L" }, "macos");
  registry.configure({ ...initialShortcutConfig(), document, status: "ready" });
  registry.dispatch(gesture("KeyK", { shift: true }), context, () => {});
  assert.equal(count, 0);
  registry.dispatch(gesture("KeyL", { shift: true }), context, () => {});
  assert.equal(count, 1);
  assert.equal(runtime.listPaletteActions()[0].binding, "Mod+Shift+L");
  const unbound = { ...document, profiles: { "desktop:macos": { ...document.profiles["desktop:macos"], "minke.palette.open": null } } };
  registry.configure({ ...initialShortcutConfig(), document: unbound, status: "ready" });
  registry.dispatch(gesture("KeyL", { shift: true }), context, () => {});
  assert.equal(count, 1);
  assert.equal(runtime.listPaletteActions()[0].binding, null);
  runtime.dispose();
});
