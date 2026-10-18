import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bindWindowFullscreen } from "@minke/desktop/main/window-fullscreen.ts";

function fixture(platform = "darwin") {
  const window = new EventEmitter();
  const contents = new EventEmitter();
  const messages = [];
  window.webContents = contents;
  window.fullscreen = false;
  window.destroyed = false;
  contents.destroyed = false;
  window.isFullScreen = () => window.fullscreen;
  window.isDestroyed = () => window.destroyed;
  contents.isDestroyed = () => contents.destroyed;
  contents.send = (...args) => messages.push(args);
  const dispose = bindWindowFullscreen(window, platform);
  return { window, contents, messages, dispose };
}

test("macOS and Windows publish current fullscreen state on transitions and every page load", () => {
  for (const platform of ["darwin", "win32"]) {
    const f = fixture(platform);
    f.contents.emit("did-finish-load");
    f.window.fullscreen = true;
    f.window.emit("enter-full-screen");
    f.contents.emit("did-finish-load");
    f.window.fullscreen = false;
    f.window.emit("leave-full-screen");
    f.contents.emit("did-finish-load");
    assert.deepEqual(f.messages, [false, true, true, false, false].map(
      state => ["dsh-desktop:window-fullscreen", state],
    ));
    f.dispose();
  }
});

test("fullscreen notifications stop after destruction or disposal and release both event sources", () => {
  for (const target of ["window", "contents"]) {
    const f = fixture();
    f[target].destroyed = true;
    f.window.emit("enter-full-screen");
    f.contents.emit("did-finish-load");
    assert.deepEqual(f.messages, []);
    // Disposal must not fetch webContents from an already-destroyed BrowserWindow.
    Object.defineProperty(f.window, "webContents", { get() { throw new Error("destroyed"); } });
    f.dispose();
    f.dispose();
    f.window.emit("leave-full-screen");
    f.contents.emit("did-finish-load");
    assert.deepEqual(f.messages, []);
    assert.equal(f.window.listenerCount("enter-full-screen"), 0);
    assert.equal(f.window.listenerCount("leave-full-screen"), 0);
    assert.equal(f.contents.listenerCount("did-finish-load"), 0);
  }
});

test("Linux retains its native layout without desktop fullscreen notifications", () => {
  const f = fixture("linux");
  f.window.fullscreen = true;
  f.window.emit("enter-full-screen");
  f.contents.emit("did-finish-load");
  assert.deepEqual(f.messages, []);
  assert.equal(f.window.listenerCount("enter-full-screen"), 0);
  assert.equal(f.contents.listenerCount("did-finish-load"), 0);
  f.dispose();
});
