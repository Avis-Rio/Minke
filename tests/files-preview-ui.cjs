'use strict';

const assert = require('node:assert/strict');
const { realpath, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { nativeTheme } = require('electron');
const { fillsFullscreenViewport } = require('./support/sidebar-geometry.cjs');

/** Runs against the production renderer and DSH document slots, with real local files. */
async function verifyFilesPreviewUI({ window, rendererValue, waitFor, workspace, click, pressKey, readOpenedFilePaths }) {
  workspace = await realpath(workspace);
  await Promise.all([
    writeFile(join(workspace, 'preview-notes.md'), '# Rendered notes\n\n**Bold text**\n\n| Name | Value |\n| --- | --- |\n| Preview | Ready |\n'),
    writeFile(join(workspace, 'preview-page.html'), '<!doctype html><html><head><link rel="stylesheet" href="preview-style.css"></head><body><h1>HTML preview</h1><button id="counter">0</button><script src="preview-script.js"></script></body></html>'),
    writeFile(join(workspace, 'preview-style.css'), 'body{padding:20px;font:16px system-ui;background:#fff;color:#123456}'),
    writeFile(join(workspace, 'preview-script.js'), 'document.body.dataset.ready="yes";document.querySelector("#counter").onclick=event=>event.target.textContent=Number(event.target.textContent)+1;'),
    writeFile(join(workspace, 'preview-source.ts'), 'export const source = true;\n'),
  ]);
  if (await rendererValue(window, '() => document.querySelector("[data-dockkit-add-tab]:not([disabled])") !== null')) {
    await click('[data-dockkit-add-tab]:not([disabled])');
  }
  await waitFor(() => rendererValue(window, '() => document.querySelector("[data-sidebar-right-guide] [data-option=files]") !== null'), 'Files creator on native Start');
  await click('[data-sidebar-right-guide] [data-option="files"]');
  const host = '.minke-tabs-native-host[data-kind="files"]:not([inert])';
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} .minke-files-explorer') !== null`), 'new Files instance');
  const openFile = async name => {
    const path = join(workspace, name);
    await click(`${host} [data-kind="file"][title=${JSON.stringify(path)}]`);
    await waitFor(() => rendererValue(window, `() => document.querySelector('${host} .minke-files-preview__header strong')?.title === ${JSON.stringify(path)} && document.querySelector('${host} .cm-content') !== null`), `${name} source`);
  };
  const choose = async mode => {
    const more = `${host} button[aria-label="More file actions"]`;
    const compact = await rendererValue(window, `() => document.querySelector('${more}') !== null`);
    if (compact) {
      await click(more);
      await click(`[role="menu"][aria-label="More file actions"] [data-option="${mode}"]`);
    } else await click(`${host} button[aria-label="${{ preview: 'Preview', source: 'Source', diff: 'Diff' }[mode]}"]`);
    if (mode === 'source') await waitFor(() => rendererValue(window, `() => document.querySelector('${host} .cm-content[contenteditable="true"]') !== null`), 'source editor remount');
  };
  const resizePreview = async width => {
    const separator = `${host} [role="separator"]`;
    // Set up keyboard resizing without racing pane activation on pointerdown.
    await rendererValue(window, `() => { document.querySelector('${separator}').focus(); return true; }`);
    await waitFor(() => rendererValue(window, `() => document.activeElement === document.querySelector('${separator}')`), 'focused preview divider');
    const readWidth = () => rendererValue(window, `() => document.querySelector('${host} .minke-files-preview').getBoundingClientRect().width`);
    const right = await rendererValue(window, `() => document.querySelector('${host} .minke-files-browser').dataset.explorerPosition === 'right'`);
    for (let step = 0; step < 64; step++) {
      const previous = await readWidth();
      // The accessible divider moves in 16px steps. Wait for each React commit
      // before sending the next key, just as a user holds or repeats an arrow.
      if (Math.abs(previous - width) < 16) {
        await rendererValue(window, '() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
        return;
      }
      pressKey((width > previous) === right ? 'Right' : 'Left');
      await waitFor(async () => Math.abs(await readWidth() - previous) > 1, 'preview divider keyboard resize', 8_000);
    }
    assert.fail(`Preview divider did not reach ${width}px`);
  };
  const capture = async label => {
    if (!process.env.MINKE_FILES_PREVIEW_SCREENSHOT) return;
    const clip = label.startsWith('compact-menu') ? await rendererValue(window, `() => {
      const menu = document.querySelector('[role="menu"][aria-label="More file actions"]').getBoundingClientRect();
      const header = document.querySelector('${host} .minke-files-preview__header').getBoundingClientRect();
      const x = Math.max(0, Math.floor(Math.min(menu.left, header.left) - 8));
      const y = Math.max(0, Math.floor(header.top - 8));
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(menu.right, header.right) - x + 8)), height: Math.min(innerHeight - y, Math.ceil(menu.bottom - y + 8)) };
    }`) : undefined;
    await writeFile(`${process.env.MINKE_FILES_PREVIEW_SCREENSHOT}.${label}.png`, (await window.webContents.capturePage(clip)).toPNG());
  };
  await openFile('preview-notes.md');
  const codeFont = await rendererValue(window, `() => ({
    setting: getComputedStyle(document.body).getPropertyValue('--dsh-code-font-size').trim(),
    editor: getComputedStyle(document.querySelector('${host} .cm-editor')).fontSize,
  })`);
  assert.equal(codeFont.setting, '12px', 'General code font change survives Settings navigation');
  assert.equal(codeFont.editor, codeFont.setting, 'Files follows the General code font size');
  await choose('preview');
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} [data-document-markdown] h1')?.textContent === 'Rendered notes'`), 'DSH Markdown heading');
  assert.equal(await rendererValue(window, `() => document.querySelector('${host} [data-document-markdown] table')?.textContent.includes('Ready')`), true, 'Markdown tables are rendered');
  await choose('source');
  await click(`${host} .cm-content`);
  await waitFor(() => rendererValue(window, `() => document.activeElement === document.querySelector('${host} .cm-content')`), 'source editor keyboard focus');
  for (const type of ['keyDown', 'keyUp']) window.webContents.sendInputEvent({ type, keyCode: 'A', modifiers: [process.platform === 'darwin' ? 'meta' : 'control'] });
  await waitFor(() => rendererValue(window, `() => {
    const selection = window.getSelection();
    const editor = document.querySelector('${host} .cm-content');
    return editor.contains(selection?.anchorNode) && selection.toString().includes('Rendered notes') && selection.toString().includes('Preview | Ready');
  }`), 'source select-all before replacing draft');
  await window.webContents.insertText('# Unsaved preview\n\nUpdated **draft**.');
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} .minke-files-preview__dirty') !== null`), 'dirty draft');
  await choose('preview');
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} [data-document-markdown] h1')?.textContent === 'Unsaved preview'`), 'preview renders current unsaved draft');
  process.stdout.write('[files-preview-ui] rendered Markdown and unsaved draft passed\n');
  await click('[data-sidebar-right-mode="fullscreen"]');
  await waitFor(() => rendererValue(window, `() => (${fillsFullscreenViewport})(${JSON.stringify(host)})`), 'fullscreen host geometry');
  await resizePreview(520);
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} button[aria-label="Preview"]') !== null`), 'wide preview controls');
  await capture('wide-markdown');
  await resizePreview(310);
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} button[aria-label="Preview"]') !== null && document.querySelector('${host} button[aria-label="More file actions"]') === null`), '300px preview retains direct actions', 2_000);
  await click('[data-sidebar-right-mode="push"]');
  window.setContentSize(980, 800);
  await waitFor(() => rendererValue(window, `() => innerWidth === 980 && document.querySelector('${host}').getBoundingClientRect().width < 980`), 'docked host geometry');
  await resizePreview(240);
  const more = `${host} button[aria-label="More file actions"]`;
  await waitFor(() => rendererValue(window, `() => document.querySelector('${more}') !== null`), 'narrow preview overflow menu', 8_000);
  await new Promise(resolve => setTimeout(resolve, 150));
  const geometry = await rendererValue(window, `() => {
    const header = document.querySelector('${host} .minke-files-preview__header');
    const title = header.querySelector('strong').getBoundingClientRect();
    const buttons = [...header.querySelectorAll('button')];
    return { buttons: buttons.map(button => button.getAttribute('aria-label')), titleWidth: title.width, overlap: title.right > buttons[0].getBoundingClientRect().left };
  }`);
  assert.deepEqual(geometry.buttons, ['More file actions', 'Close preview']);
  assert.ok(geometry.titleWidth > 60 && !geometry.overlap, JSON.stringify(geometry));
  await click(more);
  const menu = '[role="menu"][aria-label="More file actions"]';
  await waitFor(() => rendererValue(window, `() => document.querySelector('${menu} [data-option="preview"]') !== null`), 'mounted file actions menu', 8_000);
  const labels = await rendererValue(window, `() => [...document.querySelectorAll('${menu} button')].map(button => button.textContent.trim())`);
  assert.deepEqual(labels, ['Preview', 'Source', 'Diff', 'Open containing folder']);
  assert.equal(await rendererValue(window, `() => document.querySelector('${menu} [data-option="preview"]').getAttribute('aria-checked')`), 'true');
  await capture('compact-menu');
  nativeTheme.themeSource = 'dark';
  await new Promise(resolve => setTimeout(resolve, 100));
  await capture('compact-menu-dark');
  nativeTheme.themeSource = 'light';
  pressKey('Escape');
  await waitFor(() => rendererValue(window, `() => document.querySelector('${menu}') === null && document.activeElement === document.querySelector('${more}')`), 'Escape returns focus to More');
  await choose('diff');
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} .minke-files-preview__state')?.textContent.includes('not in a Git repository')`), 'diff remains accessible');
  await choose('source');
  assert.equal(await rendererValue(window, `() => document.querySelector('${host} .cm-content')?.textContent.includes('Unsaved preview')`), true, 'all three modes retain the draft');
  const openedBefore = (await readOpenedFilePaths()).length;
  await click(more);
  await click(`${menu} [data-option="open-folder"]`);
  await waitFor(async () => (await readOpenedFilePaths()).length === openedBefore + 1, 'containing folder opened through Session Remote');
  assert.equal((await readOpenedFilePaths()).at(-1), workspace, 'file jump opens its directory, not the file in a default application');
  assert.equal(await rendererValue(window, `() => document.querySelector('${host} .cm-content')?.textContent.includes('Unsaved preview')`), true, 'opening the containing folder preserves the draft');
  await rendererValue(window, '() => { window.confirm = () => false; return true; }');
  await click(`${host} button[aria-label="Close preview"]`);
  assert.equal(await rendererValue(window, `() => document.querySelector('${host} .minke-files-preview__dirty') !== null`), true, 'the persistent close button still guards unsaved drafts');
  // The fixture owns its draft; permit switching files without saving to disk.
  await rendererValue(window, '() => { window.confirm = () => true; return true; }');
  await click(`${host} button[aria-label="Close preview"]`);
  await waitFor(() => rendererValue(window, `() => document.querySelector('${host} .minke-files-preview') === null`), 'persistent close button closes the preview');
  await openFile('preview-page.html');
  await choose('preview');
  const frame = await waitFor(async () => {
    const url = await rendererValue(window, `() => document.querySelector('${host} iframe[data-html-preview]')?.src`);
    const candidate = window.webContents.mainFrame.framesInSubtree.find(value => value.url === url);
    if (!candidate) return false;
    return await candidate.executeJavaScript('document.body?.dataset.ready === "yes"') ? candidate : false;
  }, 'DSH HTML preview and relative script');
  assert.deepEqual(await frame.executeJavaScript(`({ heading: document.querySelector('h1').textContent, color: getComputedStyle(document.body).color, bridge: typeof window.minke })`), {
    heading: 'HTML preview', color: 'rgb(18, 52, 86)', bridge: 'undefined',
  }, 'HTML loads its relative stylesheet without exposing the application bridge');
  assert.equal(await rendererValue(window, `() => document.querySelector('${host} iframe[data-html-preview]').getAttribute('sandbox')`), 'allow-scripts');
  await frame.executeJavaScript('document.querySelector("#counter").click()');
  assert.equal(await frame.executeJavaScript('document.querySelector("#counter").textContent'), '1', 'HTML remains interactive');
  const bounds = await rendererValue(window, `() => {
    const frame = document.querySelector('${host} iframe[data-html-preview]');
    const rect = frame.getBoundingClientRect();
    return { width: rect.width, height: rect.height, top: rect.top, visible: frame.checkVisibility({ checkVisibilityCSS: true }) };
  }`);
  assert.ok(bounds.visible && bounds.width >= 140 && bounds.height >= 240 && bounds.top < 300, JSON.stringify(bounds));
  const wasVisible = window.isVisible();
  if (!wasVisible) window.showInactive();
  try {
    await frame.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await capture('html');
  } finally { if (!wasVisible) window.hide(); }
  await choose('source');
  assert.equal(await rendererValue(window, `() => document.querySelector('${host} .cm-content')?.textContent.includes('<!doctype html>')`), true);
  await openFile('preview-source.ts');
  await click(more);
  assert.equal(await rendererValue(window, `() => document.querySelector('${menu} [data-option="preview"]') === null`), true, 'source-only files do not offer a rendered view');
  pressKey('Escape');
  process.stdout.write('[files-preview-ui] Markdown, HTML assets, draft switching and responsive menu passed\n');
}

module.exports = { verifyFilesPreviewUI };
