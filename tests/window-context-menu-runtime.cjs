"use strict";

const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { app, BrowserWindow, Menu } = require("electron");
const { buildSync } = require("esbuild");

const root = mkdtempSync(join(tmpdir(), "minke-context-menu-"));
mkdirSync(join(root, "user-data"));
app.setPath("userData", join(root, "user-data"));
app.on("window-all-closed", () => {});
const source = join(root, "context-menu.cjs");
buildSync({ entryPoints: [join(__dirname, "..", "desktop/main/window-context-menu.ts")],
  bundle: true, format: "cjs", platform: "node", outfile: source });
const { bindWindowContextMenu } = require(source);
let window;
const deadline = setTimeout(() => { console.error("Native context menu test timed out"); finish(1); }, 15_000);

async function run() {
  await app.whenReady();
  window = new BrowserWindow({ show: false, width: 600, height: 400,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const contents = window.webContents;
  const menus = [];
  const dispose = bindWindowContextMenu(window, { buildFromTemplate: items => {
    const native = Menu.buildFromTemplate(items);
    return { popup: options => { assert.equal(options.window, window); menus.push(native); } };
  } }, key => key);
  await window.loadURL("data:text/html," + encodeURIComponent(
    '<!doctype html><textarea id="editor" style="width:300px;height:60px">Editable text</textarea>' +
    '<p id="selection">Read-only selected text</p><div id="blank" style="width:300px;height:80px"></div>'
  ));
  contents.debugger.attach("1.3");
  const open = async (id, selected) => {
    const point = await contents.executeJavaScript(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      if (${selected}) {
        if (element instanceof HTMLTextAreaElement) { element.focus(); element.select(); }
        else { const range = document.createRange(); range.selectNodeContents(element);
          getSelection().removeAllRanges(); getSelection().addRange(range); }
      } else getSelection().removeAllRanges();
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 10, y: rect.top + 10 };
    })()`);
    const received = new Promise(resolve => contents.once("context-menu", (_event, params) => resolve(params)));
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "right", clickCount: 1 });
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "right", clickCount: 1 });
    return received;
  };
  const editable = await open("editor", true);
  assert.equal(editable.isEditable, true);
  assert.equal(menus.length, 1, "an editable field opens its native menu");
  const roles = menus.at(-1).items.filter(item => item.role);
  assert.deepEqual(roles.map(item => item.role), ["undo", "redo", "cut", "copy", "paste", "selectall"]);
  assert.equal(roles.find(item => item.role === "cut").enabled, true);
  assert.equal(roles.find(item => item.role === "copy").enabled, true);
  const selection = await open("selection", true);
  assert.equal(selection.isEditable, false);
  assert.equal(selection.selectionText, "Read-only selected text");
  assert.deepEqual(menus.at(-1).items.map(item => item.role), ["copy"]);
  const count = menus.length;
  await open("blank", false);
  assert.equal(menus.length, count, "blank areas have no native edit menu");
  dispose();
  await open("editor", true);
  assert.equal(menus.length, count, "disposed windows no longer open menus");
  contents.debugger.detach();
  for (const action of ["close", "destroy", "quit"]) {
    if (window.isDestroyed()) window = new BrowserWindow({ show: false });
    const closingWindow = window;
    const closingContents = closingWindow.webContents;
    const disposeOnClose = bindWindowContextMenu(closingWindow, Menu, key => key);
    const closed = new Promise((resolve, reject) => closingWindow.once("closed", () => {
      try {
        assert.equal(closingWindow.isDestroyed(), true);
        disposeOnClose();
        disposeOnClose();
        assert.equal(closingContents.listenerCount("context-menu"), 0);
        resolve();
      } catch (error) { reject(error); }
    }));
    if (action === "quit") {
      const quitting = new Promise(resolve => app.once("will-quit", event => {
        event.preventDefault();
        resolve();
      }));
      app.quit();
      await Promise.all([closed, quitting]);
    } else {
      closingWindow[action]();
      await closed;
    }
  }
  console.log("Native context menu passed: editable actions, selected text, blank areas, disposal after close, destroy and app.quit");
}

function finish(code) {
  clearTimeout(deadline);
  if (window && !window.isDestroyed()) window.destroy();
  rmSync(root, { recursive: true, force: true });
  app.exit(code);
}
run().then(() => finish(0), error => { console.error(error); finish(1); });
