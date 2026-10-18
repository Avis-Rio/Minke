import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FilePreviewPane } from "@minke/harness-overlay/client/tabs/files/FilePreviewPane.tsx";
import { FilesTabsController } from "@minke/harness-overlay/client/tabs/files/controller.ts";
import { filesTabsEn } from "@minke/harness-overlay/client/tabs/files/locales.ts";
import { TabsRuntime } from "@minke/harness-overlay/client/tabs/runtime.ts";

const t = key => filesTabsEn[key];
const version = "test-version";
const settle = () => new Promise(resolve => setImmediate(resolve));

test("renderable files expose Preview alongside Source and Diff", () => {
  for (const [name, available] of [["README.md", true], ["Notes.MARKDOWN", true], ["index.HTML", true], ["page.htm", true], ["main.ts", false]]) {
    const snapshot = { theme: "github-light-default" };
    const markup = renderToStaticMarkup(createElement(FilePreviewPane, {
      tabId: "files-1", active: false, t,
      controller: { pathActions: { getSnapshot: () => true, subscribe: () => () => {} } },
      codeThemes: { getSnapshot: () => snapshot, subscribe: () => () => {} },
      preview: {
        entry: { path: `/workspace/${name}`, name, kind: "file" },
        mode: "source", loading: false, dirty: false, saving: false,
        result: { kind: "text", path: `/workspace/${name}`, name, content: "# Hello", size: 7, version, truncated: false },
      },
    }));
    assert.equal(markup.includes('aria-label="Preview"'), available, name);
    assert.ok(markup.includes('aria-label="Source"') && markup.includes('aria-label="Diff"'));
  }
});

test("preview switches retain drafts and lazy diff; unsupported and incomplete documents stay in source", async () => {
  const tabs = new TabsRuntime({ showPanel() {}, hidePanel() {} });
  let diffReads = 0;
  const files = new FilesTabsController(tabs, {
    available: true,
    async list({ path }) { return { path, entries: [], truncated: false }; },
    async preview({ path }) { return { kind: "text", path, name: path.split("/").at(-1), content: "# Original", size: 10, version, truncated: path.includes("large") }; },
    async diff({ path }) { diffReads++; return { kind: "text", path, original: "# HEAD" }; },
    async write() { throw new Error("switching modes must not save"); },
    watch() { return () => {}; },
  });
  try {
    const id = files.openFile("/workspace/README.md", "Files");
    await settle();
    files.updatePreviewDraft(id, "/workspace/README.md", "# Unsaved");
    files.setPreviewMode(id, "preview");
    assert.equal(tabs.tab(id).payload.preview.mode, "preview");
    assert.equal(diffReads, 0);
    files.setPreviewMode(id, "diff");
    await settle();
    files.setPreviewMode(id, "preview");
    files.setPreviewMode(id, "source");
    assert.equal(tabs.tab(id).payload.preview.draft, "# Unsaved");
    assert.equal(tabs.tab(id).payload.preview.dirty, true);
    assert.equal(diffReads, 1);
    for (const name of ["main.ts", "large.html"]) {
      const next = files.openFile(`/workspace/${name}`, "Files");
      await settle();
      files.setPreviewMode(next, "preview");
      assert.equal(tabs.tab(next).payload.preview.mode, "source", name);
    }
  } finally { files.dispose(); tabs.dispose(); }
});

test("file location opens the containing folder for POSIX, drive-root and UNC paths", () => {
  const tabs = new TabsRuntime({ showPanel() {}, hidePanel() {} });
  const opened = [];
  const files = new FilesTabsController(tabs, {
    available: true,
  }, { pathActions: {
    getSnapshot: () => true, subscribe: () => () => {},
    async open(path) { opened.push(path); },
  } });
  try {
    for (const [path, folder] of [
      ["/workspace/src/main.ts", "/workspace/src"],
      ["/README.md", "/"],
      ["C:\\work\\main.ts", "C:\\work"],
      ["C:\\main.ts", "C:\\"],
      ["\\\\server\\share\\src\\main.ts", "\\\\server\\share\\src"],
    ]) {
      files.openContainingFolder("files-1", path);
      assert.equal(opened.at(-1), folder);
    }
  } finally { files.dispose(); tabs.dispose(); }
});
