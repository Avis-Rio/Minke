import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TabsRuntime } from "@minke/harness-overlay/client/tabs/runtime.ts";
import { TabRendererRegistry } from "@minke/harness-overlay/client/tabs/registry.ts";
import { persistTabs } from "@minke/harness-overlay/client/tabs/persistence.ts";
import { FilesTabsController } from "@minke/harness-overlay/client/tabs/files/controller.ts";
import { saveFilesTab } from "@minke/harness-overlay/client/tabs/files/persistence.ts";
import { WebTabsController } from "@minke/harness-overlay/client/tabs/web/controller.ts";
import { createWebTabRenderer } from "@minke/harness-overlay/client/tabs/web/renderer.tsx";
import { FileManagerRuntime } from "@minke/harness-overlay/host/file-manager.ts";
import { createNativeTerminalRenderer } from "@minke/harness-overlay/client/tabs/terminal/native.tsx";

const host = { showPanel() {}, hidePanel() {} };
const translate = key => key;
const storage = () => {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
};
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await tick(); }
  assert.fail("condition did not settle");
}
function webWorkspace(saved, placement = "right") {
  const tabs = new TabsRuntime(host, placement === "bottom" ? { idPrefix: "bottom-" } : {});
  const web = new WebTabsController(tabs, { available: true });
  const registry = new TabRendererRegistry();
  registry.register(createWebTabRenderer(web, translate));
  const persistence = persistTabs(tabs, registry, placement, saved);
  return { tabs, web, stop: persistence.start() };
}

test("refresh restores Web identity, selected content and independent bottom tabs", () => {
  const saved = storage();
  const first = webWorkspace(saved);
  const id = first.web.createBlank("Browser");
  first.web.update(id, { url: "https://example.com/path", title: "Example" });
  const bottom = webWorkspace(saved, "bottom");
  const bottomId = bottom.web.open("https://example.org/");
  first.stop();
  bottom.stop();
  // Extension disposal after stopping persistence must not clear the recovery data.
  first.tabs.close(id);
  const restored = webWorkspace(saved);
  const restoredBottom = webWorkspace(saved, "bottom");
  assert.equal(restored.tabs.tab(id).payload.url, "https://example.com/path");
  assert.equal(restored.tabs.getSnapshot().activeId, id);
  assert.equal(restoredBottom.tabs.tab(bottomId).payload.url, "https://example.org/");
  assert.equal(restored.tabs.tab(bottomId), undefined);
  assert.notEqual(restored.web.createBlank("Browser"), id, "new tab ids and blank keys cannot alias restored tabs");
  restored.tabs.close(id);
  restored.stop();
  restoredBottom.stop();
  const reopened = webWorkspace(saved);
  assert.equal(reopened.tabs.tab(id), undefined, "an explicitly closed tab stays closed after refresh");
  reopened.stop();
});

test("corrupt or unsafe saved tabs do not prevent valid Web content from restoring", () => {
  const saved = storage();
  saved.setItem("minke.tabs.content.v1.right", JSON.stringify({ tabs: [
    null,
    { id: "tab-1", kind: "web", key: "bad", title: "Bad", payload: { url: "javascript:alert(1)" } },
    { id: "bottom-tab-1", kind: "web", key: "other", title: "Other panel", payload: {} },
    { id: "tab-2", kind: "web", key: "good", title: "Good", payload: { url: "https://example.com/" } },
  ] }));
  const restored = webWorkspace(saved);
  assert.deepEqual(restored.tabs.getSnapshot().tabs.map(tab => tab.id), ["tab-2"]);
  restored.stop();
});

test("a restored file draft keeps the original disk version and refuses a conflicting save", async t => {
  const directory = await mkdtemp(join(tmpdir(), "minke-draft-refresh-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "draft.txt");
  await writeFile(path, "original");
  const disk = new FileManagerRuntime({ rootPath: directory });
  const port = {
    available: true,
    list: request => disk.list(request), preview: request => disk.preview(request),
    write: request => disk.write(request), watch: () => () => {},
  };
  const saved = storage();
  const open = () => {
    const tabs = new TabsRuntime(host);
    const files = new FilesTabsController(tabs, port);
    const registry = new TabRendererRegistry();
    registry.register({ kind: "files", renderView: () => null, renderIcon: () => null,
      persistence: { save: saveFilesTab, restore: tab => files.restore(tab) } });
    const persistence = persistTabs(tabs, registry, "right", saved);
    return { tabs, files, stop: persistence.start() };
  };
  const before = open();
  const id = before.files.openFile(path, "Draft");
  await until(() => before.tabs.tab(id)?.payload.preview?.result?.kind === "text");
  const version = before.tabs.tab(id).payload.preview.result.version;
  before.files.updatePreviewDraft(id, path, "unsaved");
  before.stop();
  before.files.dispose();
  await writeFile(path, "external change");
  const after = open();
  t.after(() => { after.stop(); after.files.dispose(); });
  await until(() => after.tabs.tab(id)?.payload.loading === false);
  assert.equal(after.tabs.tab(id).payload.preview.draft, "unsaved");
  assert.equal(after.tabs.tab(id).payload.preview.result.version, version);
  after.files.savePreview(id);
  await until(() => after.tabs.tab(id).payload.preview.saveError !== undefined);
  assert.equal(await readFile(path, "utf8"), "external change");
  assert.equal(after.tabs.tab(id).payload.preview.dirty, true);
  // A non-conflicting retry must also complete, not get stuck on a stale revision.
  await writeFile(path, "original");
  after.files.savePreview(id);
  await until(() => after.tabs.tab(id).payload.preview.dirty === false);
  assert.equal(await readFile(path, "utf8"), "unsaved");
});

test("storage quota failure keeps active drafts usable and guards refresh until saved", t => {
  const previous = globalThis.window;
  const view = new EventTarget();
  globalThis.window = view;
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  t.mock.method(console, "warn", () => {});
  let full = false;
  const saved = storage();
  const workspace = webWorkspace({ ...saved, setItem(key, value) { if (full) throw new Error("quota"); saved.setItem(key, value); } });
  full = true;
  assert.doesNotThrow(() => workspace.web.open("https://example.com/"));
  const unload = () => { const event = new Event("beforeunload", { cancelable: true }); view.dispatchEvent(event); return event; };
  assert.equal(unload().defaultPrevented, true);
  full = false;
  assert.equal(unload().defaultPrevented, false);
  workspace.stop();
});

test("sidebar terminal action delegates creation to DSH without registering a second guide card", () => {
  let created = 0;
  const renderer = createNativeTerminalRenderer(() => { created++; }, translate);
  const registry = new TabRendererRegistry();
  registry.register(renderer);
  const action = registry.creators().find(option => option.id === "terminal");
  action.create({ cwd: "/workspace" });
  assert.equal(created, 1);
  assert.equal(renderer.nativeKind, "terminal");
  assert.deepEqual(registry.creators().filter(option => option.nativeKind === undefined), []);
});
