import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { bindWindowContextMenu } from "@minke/desktop/main/window-context-menu.ts";
import { DesktopLocaleRuntime } from "@minke/desktop/i18n.ts";

function fixture() {
  const contents = new EventEmitter();
  const window = {
    get webContents() {
      if (this.isDestroyed()) throw new TypeError("Object has been destroyed");
      return contents;
    },
    isDestroyed: () => false,
  };
  const menus = [];
  const locale = new DesktopLocaleRuntime("en");
  const dispose = bindWindowContextMenu(window, {
    buildFromTemplate: items => ({ popup: options => { assert.equal(options.window, window); menus.push(items); } }),
  }, key => locale.t(key));
  const show = (isEditable, selectionText, editFlags = {}) => contents.emit("context-menu", {}, {
    isEditable, selectionText, editFlags: {
      canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: false, canSelectAll: false, ...editFlags,
    },
  });
  return { window, contents, menus, locale, show, dispose };
}

test("editable fields keep native roles and reflect the focused editor's capabilities", () => {
  const { show, menus } = fixture();
  show(true, "selected", { canUndo: true, canCut: true, canCopy: true, canSelectAll: true });
  const actions = menus[0].filter(item => item.role);
  assert.deepEqual(actions.map(({ role, enabled }) => [role, enabled]), [
    ["undo", true], ["redo", false], ["cut", true], ["copy", true], ["paste", false], ["selectAll", true],
  ]);
  assert.equal(menus[0].filter(item => item.type === "separator").length, 2);
  assert.ok(actions.every(item => item.accelerator === ""));
});

test("read-only selections offer only Copy, use the current locale and leave blank areas alone", () => {
  const { show, menus, locale } = fixture();
  show(false, "");
  assert.equal(menus.length, 0);
  show(false, "selected", { canCopy: true });
  assert.deepEqual(menus[0], [{ role: "copy", label: "Copy", enabled: true, accelerator: "" }]);
  locale.setLocale("zh");
  show(false, "selected");
  assert.deepEqual(menus[1], [{ role: "copy", label: "复制", enabled: false, accelerator: "" }]);
});

test("closed windows and disposed bindings cannot open a context menu", () => {
  const { show, menus, window, dispose } = fixture();
  window.isDestroyed = () => true;
  show(true, "");
  assert.equal(menus.length, 0);
  window.isDestroyed = () => false;
  dispose();
  dispose();
  show(true, "");
  assert.equal(menus.length, 0);
});

test("closed-event cleanup releases the menu without accessing a destroyed BrowserWindow", () => {
  const { contents, window, dispose } = fixture();
  const unrelated = () => {};
  contents.on("context-menu", unrelated);
  assert.equal(contents.listenerCount("context-menu"), 2);
  window.isDestroyed = () => true;
  assert.doesNotThrow(dispose);
  assert.doesNotThrow(dispose, "repeated cleanup stays safe");
  assert.deepEqual(contents.listeners("context-menu"), [unrelated]);
});
