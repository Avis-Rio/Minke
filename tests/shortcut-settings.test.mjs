import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { desktopKeybindings } from "@minke/desktop/main/shortcut-persistence.ts";
const definition = { id: "minke.palette.open", defaults: { "desktop:macos": { code: "KeyK", modifiers: ["primary", "shift"] } } };

test("legacy migration preserves effective bindings and dormant overrides; DSH edits are durable and revision checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-shortcut-migration-"));
  let reads = 0;
  let persistence;
  try {
    const legacy = async () => { reads++; return { "palette.open": "Mod+L", "session.new": "", "future.action": "Ctrl+Alt+1" }; };
    persistence = desktopKeybindings(root, "macos", () => {}, legacy);
    persistence.setDefinitions([definition]);
    const first = await persistence.readCurrent();
    assert.equal(first.status, "ready");
    const bindings = first.document.profiles["desktop:macos"];
    assert.deepEqual(bindings["minke.palette.open"], { code: "KeyL", modifiers: ["primary"] });
    assert.equal(bindings["session.new"], null);
    assert.deepEqual(bindings["sidebar.left.toggle"], { code: "KeyS", modifiers: ["primary"] });
    assert.deepEqual(bindings["minke.future.action"], { code: "Digit1", modifiers: ["control", "alt"] });
    const saved = await persistence.edit({ type: "set", id: definition.id, binding: null }, first.revision);
    assert.equal(saved.status, "saved");
    assert.equal((await persistence.edit({ type: "reset", id: definition.id }, first.revision)).status, "stale");
    persistence.dispose();
    persistence = desktopKeybindings(root, "macos", () => {}, legacy);
    persistence.setDefinitions([definition]);
    const reopened = await persistence.readCurrent();
    assert.equal(reopened.document.profiles["desktop:macos"][definition.id], null);
    assert.equal(reads, 1, "reload never reapplies the old configuration");
    assert.equal(JSON.parse(await readFile(join(root, "keybindings.json"), "utf8")).schemaVersion, 2);
  } finally { persistence?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("future or malformed DSH preferences are never overwritten by migration", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-shortcut-invalid-"));
  let persistence;
  try {
    const path = join(root, "keybindings.json");
    const original = '{"schemaVersion":999,"profiles":{}}';
    await writeFile(path, original);
    persistence = desktopKeybindings(root, "macos", () => {}, async () => { throw new Error("must not migrate"); });
    persistence.setDefinitions([definition]);
    const snapshot = await persistence.readCurrent();
    assert.equal(snapshot.status, "unreadable");
    assert.equal(snapshot.error, "future");
    assert.equal((await persistence.edit({ type: "reset-all" }, snapshot.revision)).status, "unreadable");
    assert.equal(await readFile(path, "utf8"), original);
  } finally { persistence?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("unsupported legacy keys are reported once and preserve the original store", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-shortcut-unsupported-"));
  let persistence;
  try {
    const original = { "palette.open": "Mod+Home" };
    const notices = [];
    persistence = desktopKeybindings(root, "macos", () => {}, async () => original, bindings => notices.push(bindings));
    persistence.setDefinitions([definition]);
    const snapshot = await persistence.readCurrent();
    assert.equal(snapshot.status, "ready");
    assert.equal(snapshot.document.profiles["desktop:macos"][definition.id], null);
    assert.deepEqual(notices, [["palette.open: Mod+Home"]]);
    assert.deepEqual(original, { "palette.open": "Mod+Home" });
    await persistence.readCurrent();
    assert.equal(notices.length, 1);
  } finally { persistence?.dispose(); await rm(root, { recursive: true, force: true }); }
});
