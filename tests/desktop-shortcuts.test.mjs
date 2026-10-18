import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bundledDesktop } from "./support/bundled-desktop.mjs";
import { SHORTCUT_IPC } from "@minke/harness-overlay/shared-shortcuts-contract.ts";

class Contents extends EventEmitter {
  mainFrame = { name: "", parent: null };
  focusedFrame = this.mainFrame;
  sent = [];
  focused = true;
  ignore = false;
  isDestroyed() { return false; }
  isFocused() { return this.focused; }
  setIgnoreMenuShortcuts(value) { this.ignore = value; }
  send(channel, input) { if (channel === SHORTCUT_IPC.input) this.sent.push(input); }
  input(extra = {}) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    this.emit("before-input-event", event, { type: "keyDown", key: "k", code: "KeyK", meta: true,
      control: false, alt: false, shift: false, isComposing: false, isAutoRepeat: false, modifiers: ["meta"], ...extra });
    return event.defaultPrevented;
  }
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "minke-native-shortcuts-"));
  const handlers = new Map();
  const events = new EventEmitter();
  const window = Object.assign(new EventEmitter(), { webContents: new Contents(), closed: 0,
    isDestroyed: () => false, isFocused: () => true, isEnabled: () => true, close() { this.closed++; } });
  const { installDesktopShortcuts } = bundledDesktop("desktop/main/desktop-shortcuts.ts", {
    ipcMain: { on: events.on.bind(events), removeListener: events.removeListener.bind(events), handle: (id, handler) => handlers.set(id, handler), removeHandler: id => handlers.delete(id) },
  });
  const bridge = installDesktopShortcuts(() => window, root, "macos", () => {}, event => event.allowed === true, undefined);
  bridge.attach(window);
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame, allowed: true };
  const invoke = async (id, ...args) => handlers.get(id)(sender, ...args);
  t.after(async () => { bridge.dispose(); await rm(root, { recursive: true, force: true }); });
  const snapshot = await invoke(SHORTCUT_IPC.get, [
    { id: "minke.palette.open", defaults: { "desktop:macos": { code: "KeyK", modifiers: ["primary"] } } },
    { id: "page.close", defaults: { "desktop:macos": { code: "KeyW", modifiers: ["primary"] } } },
  ]);
  return { bridge, window, invoke, sender, handlers, snapshot, events };
}

test("native input honors composition, recording, stale revisions, navigation and trusted sender ownership", async t => {
  const { bridge, window, invoke, sender, handlers, snapshot } = await fixture(t);
  const contents = window.webContents;
  assert.equal(contents.input(), true);
  assert.equal(contents.sent.at(-1).kind, "keyboard");
  assert.equal(contents.sent.at(-1).revision, snapshot.revision);
  const count = contents.sent.length;
  contents.input({ isComposing: true });
  contents.input({ key: "Dead" });
  contents.input({ key: "é" });
  assert.equal(contents.sent.length, count, "composition cannot trigger commands");
  await invoke(SHORTCUT_IPC.recording, true);
  assert.equal(contents.ignore, true);
  contents.input();
  assert.equal(contents.sent.length, count);
  await invoke(SHORTCUT_IPC.recording, false);
  await invoke(SHORTCUT_IPC.close, "stale");
  assert.equal(window.closed, 0);
  await invoke(SHORTCUT_IPC.close, snapshot.revision);
  assert.equal(window.closed, 1);
  await assert.rejects(async () => handlers.get(SHORTCUT_IPC.get)({ ...sender, allowed: false }, []), /rejected origin/);
  contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  contents.input();
  assert.equal(contents.sent.length, count, "navigation revokes the previous document's definitions");
  bridge.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(contents.listenerCount("before-input-event"), 0);
});

test("embedded guest keys carry focused guest identity and release their input ownership", async t => {
  const { bridge, window } = await fixture(t);
  const guest = new Contents();
  const off = bridge.attachGuest(window, guest, "minke-guest-42");
  guest.focused = false;
  assert.equal(guest.input(), false);
  assert.equal(window.webContents.sent.length, 0);
  guest.focused = true;
  assert.equal(guest.input(), true);
  assert.equal(window.webContents.sent.at(-1).kind, "webview");
  assert.equal(window.webContents.sent.at(-1).frameName, "minke-guest-42");
  off();
  assert.equal(guest.listenerCount("before-input-event"), 0);
  assert.equal(guest.ignore, false);
});


test("menu commands wait for the renderer's accepted revision when a closed window reopens", async t => {
  const { bridge, window, events, sender, snapshot } = await fixture(t);
  bridge.invoke("palette.open");
  assert.equal(window.webContents.sent.length, 0);
  events.emit(SHORTCUT_IPC.accepted, { ...sender, allowed: false }, snapshot.revision);
  events.emit(SHORTCUT_IPC.accepted, sender, "stale");
  assert.equal(window.webContents.sent.length, 0);
  events.emit(SHORTCUT_IPC.accepted, sender, snapshot.revision);
  assert.deepEqual(window.webContents.sent, [{ kind: "menu", commandId: "minke.palette.open", revision: snapshot.revision }]);
  events.emit(SHORTCUT_IPC.accepted, sender, snapshot.revision);
  assert.equal(window.webContents.sent.length, 1);
});
