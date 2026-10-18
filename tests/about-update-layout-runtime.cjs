'use strict';

const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');

const projectRoot = join(__dirname, '..');

async function waitFor(window, predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!(await window.webContents.executeJavaScript(predicate))) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assertRectStable(before, after, label) {
  for (const field of ['x', 'y', 'width', 'height']) {
    assert.ok(
      Math.abs(before[field] - after[field]) <= 0.25,
      `${label}.${field} moved from ${String(before[field])} to ${String(
        after[field],
      )}`,
    );
  }
}

function aboutBundle() {
  const source = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { AboutDialog } from "./packages/harness-overlay/src/client/about/view.tsx";
    import { en } from "./packages/harness-overlay/src/client/about/locales.ts";
    import aboutStyles from "./packages/harness-overlay/src/client/about/styles.css";

    const style = document.createElement("style");
    style.textContent = aboutStyles;
    document.head.append(style);

    const t = (key, params) =>
      en[key].replace(/\\{(\\w+)\\}/gu, (match, name) =>
        params !== undefined && Object.hasOwn(params, name)
          ? String(params[name])
          : match,
      );

    globalThis.updateOpens = 0;
    const openUpdates = () => { globalThis.updateOpens++; };

    createRoot(document.getElementById("root")).render(
      <AboutDialog
        openUpdates={openUpdates}
        iconUrl="data:image/gif;base64,R0lGODlhAQABAAAAACw="
        info={{
          available: true,
          productName: "Minke",
          version: "0.2.0",
          platform: "darwin",
          arch: "arm64",
        }}
        openExternal={() => {}}
        t={t}
        wide={true}
      />,
    );
  `;
  const result = buildSync({
    alias: {
      react: join(projectRoot, 'node_modules', 'react'),
      'react-dom': join(projectRoot, 'node_modules', 'react-dom'),
      '@minke/harness-overlay': join(
        projectRoot,
        'packages',
        'harness-overlay',
        'src',
      ),
    },
    bundle: true,
    format: 'iife',
    jsx: 'automatic',
    loader: {
      '.css': 'text',
      '.module.css': 'local-css',
    },
    platform: 'browser',
    stdin: {
      contents: source,
      loader: 'tsx',
      resolveDir: projectRoot,
    },
    target: 'chrome120',
    outfile: join(projectRoot, 'work', 'about-layout-fixture.js'),
    write: false,
  });
  const css = result.outputFiles.find(file => file.path.endsWith('.css')).text;
  const script = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  return `const nativeStyle = document.createElement('style'); nativeStyle.textContent = ${JSON.stringify(css)}; document.head.append(nativeStyle);\n${script}`
    .replaceAll('</script>', '<\\/script>');
}

async function geometry(window) {
  return await window.webContents.executeJavaScript(`
    (() => {
      const rect = (selector) => {
        const value = document.querySelector(selector).getBoundingClientRect();
        return {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height,
        };
      };
      return {
        panel: rect("[data-minke-about-dialog]"),
        update: rect("[data-minke-about-update-check]"),
        project: rect(".minke-about__action--primary"),
      };
    })()
  `);
}

async function aboutOwnsPanelOverlap(window) {
  return await window.webContents.executeJavaScript(`
    (() => {
      const dialog = document.querySelector("[data-minke-about-dialog]");
      const competingPanel = document.querySelector("#competing-bottom-panel");
      const dialogRect = dialog.getBoundingClientRect();
      const competingRect = competingPanel.getBoundingClientRect();
      const overlapTop = Math.max(dialogRect.top, competingRect.top);
      const overlapBottom = Math.min(dialogRect.bottom, competingRect.bottom);
      if (overlapBottom <= overlapTop) return false;
      const x = dialogRect.left + dialogRect.width / 2;
      const y = overlapTop + (overlapBottom - overlapTop) / 2;
      return dialog.contains(document.elementFromPoint(x, y));
    })()
  `);
}

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    width: 380,
    height: 700,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.on(
    'console-message',
    (details) => {
      if (details.message) {
        console.error(`renderer: ${details.message}`);
      }
    },
  );
  const bundle = aboutBundle();
  const fixtureDirectory = await mkdtemp(join(tmpdir(), 'minke-about-layout-'));
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta
          http-equiv="Content-Security-Policy"
          content="default-src 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'"
        >
        <style>
          :root {
            --ds-font-family-code: ui-monospace;
          }
          html, body, #fixture-layer, #root {
            width: 100%;
            height: 100%;
            margin: 0;
          }
          #fixture-layer {
            position: relative;
            z-index: 1;
          }
          #competing-bottom-panel {
            position: fixed;
            z-index: 2;
            right: 0;
            bottom: 0;
            left: 0;
            height: 50%;
            background: #111;
          }
          *, *::before, *::after {
            animation: none !important;
            transition: none !important;
          }
        </style>
      </head>
      <body>
        <div id="fixture-layer"><div id="root"></div></div>
        <div id="competing-bottom-panel"></div>
        <script>${bundle}</script>
      </body>
    </html>
  `;

  try {
    // Native UI modules make this fixture larger than Chromium's data-URL limit.
    const fixturePath = join(fixtureDirectory, 'index.html');
    await writeFile(fixturePath, html);
    await window.loadFile(fixturePath);
    await waitFor(
      window,
      'document.querySelector("[data-minke-about-trigger]") !== null',
      'About trigger',
    );
    await window.webContents.executeJavaScript(
      'document.querySelector("[data-minke-about-trigger]").click()',
    );
    await waitFor(
      window,
      'document.querySelector("[data-minke-about-update-check]") !== null',
      'About update button',
    );

    assert.equal(
      await aboutOwnsPanelOverlap(window),
      true,
      'About dialog must paint above an overlapping bottom panel',
    );

    const initial = await geometry(window);
    assert.equal(initial.update.height, 36, 'update action uses the native medium Button');
    assert.equal(initial.project.height, initial.update.height, 'project link aligns with the native action');
    await window.webContents.executeJavaScript(
      'document.querySelector("[data-minke-about-update-check]").click()',
    );
    await waitFor(window,
      'document.querySelector("[data-minke-about-dialog]") === null && globalThis.updateOpens === 1',
      'About hands off to the standard update action');
    await waitFor(window,
      'document.activeElement === document.querySelector("[data-minke-about-trigger]")',
      'focus returns to the About trigger');
    await window.webContents.executeJavaScript(
      'document.querySelector("[data-minke-about-trigger]").click()',
    );
    await waitFor(window,
      'document.querySelector("[data-minke-about-update-check]") !== null',
      'About reopens after the native update action');
    const reopened = await geometry(window);
    assertRectStable(initial.update, reopened.update, 'update button');
    assertRectStable(initial.project, reopened.project, 'project button');
    assertRectStable(initial.panel, reopened.panel, 'panel after reopening');
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("[role=status]") === null'), true);
    process.stdout.write('About dialog stacking and update layout runtime regression passed\n');
  } finally {
    window.destroy();
    await rm(fixtureDirectory, { recursive: true, force: true });
    app.quit();
  }
}

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
