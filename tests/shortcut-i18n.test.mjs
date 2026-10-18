import assert from "node:assert/strict";
import test from "node:test";
import { en, zh } from "@minke/harness-overlay/client/shortcuts/locales.ts";
test("shortcut dictionaries have the same complete key set", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const dictionary of [zh, en]) {
    for (const value of Object.values(dictionary)) {
      assert.equal(typeof value, "string");
      assert.notEqual(value.trim(), "");
    }
  }
  assert.equal(zh["action.toggleSidebar"], "展开或折叠左侧栏");
  assert.equal(en["action.toggleSidebar"], "Toggle Sidebar");
  assert.equal(zh["action.commandPalette"], "打开命令面板");
  assert.equal(en["action.commandPalette"], "Open Command Palette");
  assert.equal(zh["action.focusComposer"], "聚焦消息输入框");
  assert.equal(en["action.focusComposer"], "Focus Message Input");
  assert.equal(zh["action.sessionBack"], "返回上一会话");
  assert.equal(en["action.sessionBack"], "Back to Previous Session");
  assert.equal(zh["action.sessionForward"], "前往下一会话");
  assert.equal(en["action.sessionForward"], "Forward to Next Session");
  assert.equal(
    zh["action.toggleRightSidebar"],
    "展开或折叠右侧栏",
  );
  assert.equal(
    en["action.toggleRightSidebar"],
    "Toggle Right Sidebar",
  );
  assert.equal(
    zh["action.toggleBottomPanel"],
    "展开或折叠底部栏",
  );
  assert.equal(
    en["action.toggleBottomPanel"],
    "Toggle Bottom Panel",
  );
});
