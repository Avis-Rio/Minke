'use strict';

const { app, BrowserWindow, nativeTheme } = require('electron');
const { buildSync } = require('esbuild');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const projectRoot = join(__dirname, '..');
const windowThemeChannel = 'minke:window-theme';
const windowLocaleChannel = 'minke:window-locale';

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alphaOf(value) {
  if (value.startsWith('rgb(')) return 1;
  const rgba = value.match(/rgba\([^)]*,\s*([\d.]+)\s*\)$/u);
  if (rgba) return Number(rgba[1]);
  const color = value.match(/color\([^/]+\/\s*([\d.]+)\s*\)/u);
  return color ? Number(color[1]) : 1;
}

async function run() {
  await app.whenReady();
  if (process.platform !== 'darwin') {
    process.stdout.write('macOS window runtime regression skipped\n');
    app.quit();
    return;
  }

  const earlyCss = readFileSync(
    join(projectRoot, 'resources', 'desktop-style-extension', 'early.css'),
    'utf8',
  );
  const nativeCss = readFileSync(join(projectRoot, 'vendor/deepseek-harness/packages/client/web/src/base.css'), 'utf8');
  const desktopSurfaceBundle = buildSync({
    bundle: true,
    entryPoints: [
      join(
        projectRoot,
        'packages',
        'harness-overlay',
        'src',
        'client',
        'desktop',
        'surface.ts',
      ),
    ],
    format: 'iife',
    globalName: 'MinkeDesktopSurface',
    loader: {
      '.css': 'text',
    },
    platform: 'browser',
    target: 'chrome120',
    write: false,
  }).outputFiles[0].text.replaceAll('</script>', '<\\/script>');
  const window = new BrowserWindow({
    x: 420,
    y: 260,
    width: 420,
    height: 220,
    show: true,
    titleBarStyle: 'hiddenInset',
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(
        projectRoot,
        '.vite',
        'build',
        'desktop-preload.js',
      ),
      sandbox: true,
    },
  });
  const themeMessages = [];
  const localeMessages = [];
  let domReady = false;
  let initialThemeBeforeDomReady;
  window.webContents.once('dom-ready', () => {
    domReady = true;
  });
  window.webContents.ipc.on(windowThemeChannel, (_event, message) => {
    if (initialThemeBeforeDomReady === undefined) {
      initialThemeBeforeDomReady = !domReady;
    }
    themeMessages.push(message);
    nativeTheme.themeSource = message;
  });
  window.webContents.ipc.on(windowLocaleChannel, (_event, locale) => {
    localeMessages.push(locale);
  });
  window.webContents.ipc.handle('minke:window-locale:bootstrap', async () => ({ languages: ['zh-Hant', 'en'], preference: 'fr-FR' }));
  const html = `
    <html style="color-scheme: dark" data-ds-theme-source="dark">
    <head>
    <style>
      :root {
        --dsw-alias-button-elevated-fill: rgb(255, 255, 255);
        --dsw-alias-button-floating-hover: rgb(244, 246, 248);
        --dsw-alias-button-info-fill: rgb(57, 100, 254);
        --dsw-alias-button-info-hover: rgb(74, 116, 255);
        --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
        --dsw-alias-interactive-bg-hover-solid: rgb(238, 240, 244);
        --dsw-specific-selector: rgb(255, 255, 255);
      }
      html, body { margin: 0; width: 100%; height: 100%; }
      .frame {
        position: relative;
        display: grid;
        grid-template-columns: 120px minmax(0, 1fr) 120px;
        grid-template-rows: 100%;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }
      .sidebarColumn, .centerColumn, .detailsColumn {
        min-width: 0;
      }
      .sidebarColumn, .detailsColumn {
        overflow: hidden;
      }
      .centerColumn {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      [data-shell-overlay] {
        position: absolute;
        inset: 0;
        z-index: 20;
        pointer-events: none;
      }
      .detailsHandle {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 300px;
        z-index: 2;
        width: 8px;
        margin-left: -4px;
        cursor: col-resize;
      }
      .tabsWindowDrag {
        position: absolute;
        top: 0;
        right: 0;
        z-index: 3;
        width: 60px;
        height: 28px;
      }
      .sidebar {
        width: 100%;
        padding: 6px 12px;
        box-sizing: border-box;
      }
      .logoRow {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        height: 60px;
        padding: 8px 0 8px 4px;
        box-sizing: border-box;
      }
      .toggle {
        width: 28px;
        height: 28px;
        border: 0;
        background: transparent;
      }
      .newSession {
        width: 100%;
        height: 38px;
        border: 1px solid rgba(0, 0, 0, 0.1);
        border-radius: 12px;
        background: var(--dsw-alias-button-elevated-fill);
      }
      .sessionHeader {
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
        height: 75px;
        padding: 0 16px;
      }
      .composerRow, .composerTools, .composerTrailing {
        display: flex;
        align-items: center;
      }
      .composerRow { justify-content: space-between; }
      .composerAdd, .composerPrimary {
        border: 0;
        border-radius: 999px;
      }
      .composerAdd {
        width: 28px;
        height: 28px;
        background: var(--dsw-specific-selector);
      }
      .composerPrimary {
        width: 34px;
        height: 34px;
        background: var(--dsw-alias-button-info-fill);
      }
      ${nativeCss}
      ${earlyCss}
      .sessionTitle { -webkit-app-region: no-drag; user-select: text; }
    </style>
    <script>${desktopSurfaceBundle}</script>
    </head>
    <body>
    <div id="root">
      <div class="frame">
        <div class="sidebarColumn">
          <div data-slot="sidebar">
            <div class="sidebar">
              <div class="logoRow" data-window-drag>
                <button class="toggle" aria-label="Collapse sidebar">Toggle</button>
              </div>
              <button class="newSession" aria-label="New Session">New Session</button>
            </div>
          </div>
        </div>
        <div class="centerColumn" data-phase="active">
          <div data-slot="conversation.session.header">
            <header class="sessionHeader" data-window-drag>
              <span class="sessionTitle">Session title</span>
              <button class="sessionAction" aria-label="Session action">
                Action
              </button>
            </header>
          </div>
          <div data-conversation-scroll style="height:1px;overflow:auto"></div>
          <div data-composer-card>
            <div data-input-scroll></div>
            <div class="composerRow">
              <div class="composerTools">
                <button class="composerAdd" aria-label="Commands">+</button>
              </div>
              <div class="composerTrailing">
                <button class="composerPrimary" aria-label="Send message">↑</button>
              </div>
            </div>
          </div>
        </div>
        <div class="detailsColumn">
          <div data-slot="rightbar">
            <div data-slot="rightbar.session"><div class="details" data-sidebar-right-panel="push"></div></div>
          </div>
        </div>
        <div data-shell-overlay></div>
        <div class="detailsHandle" data-side="rightbar"></div>
        <div
          class="tabsWindowDrag"
          data-minke-tabs-window-drag data-window-drag
          aria-hidden="true"
        ></div>
      </div>
    </div>
    <script>
      globalThis.toggleClicks = 0;
      document.querySelector('.toggle').addEventListener('click', () => {
        globalThis.toggleClicks += 1;
      });
      globalThis.sessionActionClicks = 0;
      document.querySelector('.sessionAction').addEventListener('click', () => {
        globalThis.sessionActionClicks += 1;
      });
      globalThis.detailsHandleMouseDowns = 0;
      document.querySelector('.detailsHandle').addEventListener(
        'mousedown',
        () => {
          globalThis.detailsHandleMouseDowns += 1;
        },
      );
      globalThis.disposeDesktopSurface =
        MinkeDesktopSurface.installDesktopSurface();
    </script>
    </body>
    </html>
  `;
  await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  window.focus();
  await waitFor(
    () =>
      window.webContents.executeJavaScript(
        "document.querySelector('.newSession')?.hasAttribute('data-dsh-desktop-new-session') === true",
      ),
    "desktop structural markers",
  );
  const redundantSurfaceWrites = await window.webContents.executeJavaScript(`
    (async () => {
      let writes = 0;
      const observer = new MutationObserver(records => {
        writes += records.filter(record =>
          record.attributeName?.startsWith('data-dsh-desktop-') &&
          record.oldValue === record.target.getAttribute(record.attributeName)
        ).length;
      });
      observer.observe(document.documentElement, {
        attributes: true, attributeOldValue: true, subtree: true,
      });
      document.body.classList.add('minke-surface-reconcile-test');
      try {
        await Promise.resolve();
        for (let frame = 0; frame < 6; frame++) {
          await new Promise(resolve => requestAnimationFrame(resolve));
        }
      } finally {
        observer.disconnect();
        document.body.classList.remove('minke-surface-reconcile-test');
      }
      return writes;
    })()
  `);
  await waitFor(() => themeMessages.length >= 1, 'initial window theme');
  await window.webContents.executeJavaScript(`
    (() => {
      window.__DSH_LOCALE__.onChange('zh');
    })()
  `);
  await waitFor(() => localeMessages.length >= 1, 'Harness window locale');
  await window.webContents.executeJavaScript(`
    (() => {
      window.__DSH_LOCALE__.onChange('fr-FR');
    })()
  `);
  await waitFor(
    () => localeMessages.length >= 2,
    'language-pack window locale',
  );
  const malformedLocaleError = await window.webContents.executeJavaScript(`
    (() => {
      try {
        window.__DSH_LOCALE__.onChange('fr_FR');
        return '';
      } catch (error) {
        return String(error);
      }
    })()
  `);
  const initialThemeSource = nativeTheme.themeSource;
  await window.webContents.executeJavaScript(`
    (() => {
      document.documentElement.setAttribute('data-ds-theme-source', 'system');
    })()
  `);
  await waitFor(() => themeMessages.length >= 2, 'system window preference');
  const systemThemeSource = nativeTheme.themeSource;
  await window.webContents.executeJavaScript(`
    (() => {
      document.documentElement.style.colorScheme = 'light';
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const messagesAfterAuthoritativeDomChange = themeMessages.length;
  await window.webContents.executeJavaScript(`
    (() => {
      document.documentElement.setAttribute('data-ds-theme-source', 'light');
    })()
  `);
  await waitFor(() => nativeTheme.themeSource === 'light', 'explicit native light theme');
  await window.webContents.executeJavaScript("document.documentElement.setAttribute('data-ds-theme-source', 'system')");
  await waitFor(() => themeMessages.length >= 4, 'updated system window theme');
  const updatedSystemThemeSource = nativeTheme.themeSource;
  const nativeLocale = await window.webContents.executeJavaScript('window.__DSH_LOCALE__.read()');
  await window.webContents.executeJavaScript(`(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'native-file-test';
    document.body.append(input);
  })()`);
  window.webContents.debugger.attach('1.3');
  let hostPaths;
  try {
    const { root } = await window.webContents.debugger.sendCommand('DOM.getDocument');
    const { nodeId } = await window.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#native-file-test' });
    await window.webContents.debugger.sendCommand('DOM.setFileInputFiles', { nodeId, files: [join(projectRoot, 'package.json')] });
    hostPaths = await window.webContents.executeJavaScript(`(() => {
      const file = document.querySelector('#native-file-test').files[0];
      return { disk: window.__DSH_HOST_PATHS__.pathFor(file), bytes: window.__DSH_HOST_PATHS__.pathFor(new File(['pasted'], 'note.txt')) };
    })()`);
  } finally {
    window.webContents.debugger.detach();
    await window.webContents.executeJavaScript("document.querySelector('#native-file-test').remove()");
  }
  const surfaceKind = await window.webContents.executeJavaScript(
    'window.minkeDesktop.surface.kind',
  );
  const platform = await window.webContents.executeJavaScript('document.documentElement.dataset.platform');

  const streamingWork = await window.webContents.executeJavaScript(`
    (async () => {
      const content = document.createElement('div');
      document.querySelector('[data-conversation-scroll]').append(content);
      const header = document.querySelector('[data-slot="conversation.session.header"]');
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      // Let mount and transition settling finish before measuring streaming updates.
      // Use elapsed time so high-refresh-rate displays get the same quiet period.
      const settleUntil = performance.now() + 500;
      do { await frame(); } while (performance.now() < settleUntil);
      const originalQuery = document.querySelectorAll;
      const originalRect = header.getBoundingClientRect;
      let documentScans = 0;
      let headerReads = 0;
      document.querySelectorAll = function (...args) {
        documentScans++;
        return originalQuery.apply(this, args);
      };
      header.getBoundingClientRect = function () {
        headerReads++;
        return originalRect.call(this);
      };
      try {
        for (let index = 0; index < 12; index++) {
          content.textContent = 'Streaming answer ' + index;
          await frame();
        }
      } finally {
        document.querySelectorAll = originalQuery;
        header.getBoundingClientRect = originalRect;
        content.remove();
      }
      return { documentScans, headerReads };
    })()
  `);

  const before = await window.webContents.executeJavaScript(`
    (() => {
      const toggle = document.querySelector('.toggle').getBoundingClientRect();
      const sessionAction =
        document.querySelector('.sessionAction').getBoundingClientRect();
      const detailsHandle =
        document.querySelector('.detailsHandle').getBoundingClientRect();
      const sessionTitle = document.querySelector('.sessionTitle');
      const sessionTitleStyle = getComputedStyle(sessionTitle);
      const detailsHandleStyle = getComputedStyle(
        document.querySelector('.detailsHandle'),
      );
      const range = document.createRange();
      range.selectNodeContents(sessionTitle);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const selectedSessionTitle = selection.toString();
      selection.removeAllRanges();
      const newSession = document.querySelector('.newSession');
      const centerColumn = document.querySelector('.centerColumn');
      const activeBackground =
        getComputedStyle(newSession).backgroundColor;
      centerColumn.dataset.phase = 'hero';
      const heroBackground =
        getComputedStyle(newSession).backgroundColor;
      centerColumn.dataset.phase = 'settling';
      const settlingBackground =
        getComputedStyle(newSession).backgroundColor;
      centerColumn.dataset.phase = 'active';
      const restoredBackground =
        getComputedStyle(newSession).backgroundColor;
      const addBackground = getComputedStyle(
        document.querySelector('.composerAdd'),
      ).backgroundColor;
      const primaryBackground = getComputedStyle(
        document.querySelector('.composerPrimary'),
      ).backgroundColor;
      return {
        addBackground,
        activeBackground,
        composerMarker: document.querySelector(
          '[data-dsh-desktop-composer-add],'
            + '[data-dsh-desktop-composer-primary]',
        ) !== null,
        detailsHandleAppRegion: detailsHandleStyle
          .getPropertyValue('-webkit-app-region')
          .trim(),
        detailsHandleMarker: document.querySelector(
          '.detailsHandle[data-dsh-desktop-resize-handle]',
        ) !== null,
        detailsHandlePoint: {
          x: Math.round(detailsHandle.x + 2),
          y: 32,
        },
        primaryBackground,
        heroBackground,
        restoredBackground,
        selectedSessionTitle,
        sessionActionPoint: {
          x: Math.round(sessionAction.x + sessionAction.width / 2),
          y: Math.round(sessionAction.y + sessionAction.height / 2),
        },
        sessionTitleAppRegion: sessionTitleStyle
          .getPropertyValue('-webkit-app-region')
          .trim(),
        sessionTitleUserSelect: sessionTitleStyle.userSelect,
        settlingBackground,
        togglePoint: {
          x: Math.round(toggle.x + toggle.width / 2),
          y: Math.round(toggle.y + toggle.height / 2),
        },
      };
    })()
  `);
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: before.togglePoint.x,
    y: before.togglePoint.y,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: before.togglePoint.x,
    y: before.togglePoint.y,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: before.sessionActionPoint.x,
    y: before.sessionActionPoint.y,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: before.sessionActionPoint.x,
    y: before.sessionActionPoint.y,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: before.detailsHandlePoint.x,
    y: before.detailsHandlePoint.y,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: before.detailsHandlePoint.x,
    y: before.detailsHandlePoint.y,
    button: 'left',
    clickCount: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const clicks = await window.webContents.executeJavaScript(`({
    detailsHandle: globalThis.detailsHandleMouseDowns,
    sessionAction: globalThis.sessionActionClicks,
    toggle: globalThis.toggleClicks,
  })`);
  const disposedSurface = await window.webContents.executeJavaScript(`
    (() => {
      globalThis.disposeDesktopSurface();
      return {
        conversationHeaderRegion: getComputedStyle(
          document.querySelector('.sessionHeader'),
        ).getPropertyValue('-webkit-app-region').trim(),
        marker: document.querySelector(
          '[data-dsh-desktop-new-session]',
        ) !== null,
        resizeHandleMarker: document.querySelector(
          '[data-dsh-desktop-resize-handle]',
        ) !== null,
        style: document.querySelector(
          'style[data-minke-style="desktop-surface"]',
        ) !== null,
      };
    })()
  `);
  const result = {
    activeBackground: before.activeBackground,
    activeBackgroundAlpha: alphaOf(before.activeBackground),
    addBackground: before.addBackground,
    composerMarker: before.composerMarker,
    detailsHandleAppRegion: before.detailsHandleAppRegion,
    detailsHandleMarker: before.detailsHandleMarker,
    detailsHandleMouseDowns: clicks.detailsHandle,
    disposedSurface,
    platform,
    initialThemeBeforeDomReady,
    initialThemeSource,
    nativeLocale,
    hostPaths,
    malformedLocaleError,
    heroBackground: before.heroBackground,
    heroBackgroundAlpha: alphaOf(before.heroBackground),
    localeMessages,
    messagesAfterAuthoritativeDomChange,
    primaryBackground: before.primaryBackground,
    restoredBackground: before.restoredBackground,
    restoredBackgroundAlpha: alphaOf(before.restoredBackground),
    selectedSessionTitle: before.selectedSessionTitle,
    sessionActionClicks: clicks.sessionAction,
    sessionTitleAppRegion: before.sessionTitleAppRegion,
    sessionTitleUserSelect: before.sessionTitleUserSelect,
    settlingBackground: before.settlingBackground,
    settlingBackgroundAlpha: alphaOf(before.settlingBackground),
    systemThemeSource,
    surfaceKind,
    redundantSurfaceWrites,
    streamingWork,
    themeMessages,
    toggleClicks: clicks.toggle,
    updatedSystemThemeSource,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  window.destroy();
  nativeTheme.themeSource = 'system';
  app.quit();

  const failures = [];
  if (JSON.stringify(result.nativeLocale) !== JSON.stringify({ languages: ['zh-Hant', 'en'], preference: 'fr-FR' })) failures.push('DSH locale bootstrap did not cross the isolated preload');
  if (result.hostPaths.disk !== join(projectRoot, 'package.json') || result.hostPaths.bytes !== '') failures.push('DSH host paths must preserve real disk files and leave pasted bytes to upload');
  if (result.redundantSurfaceWrites !== 0) {
    failures.push('desktop reconciliation rewrote unchanged markers: ' + result.redundantSurfaceWrites);
  }
  if (result.streamingWork.documentScans !== 0 || result.streamingWork.headerReads !== 0) {
    failures.push('streaming text triggered document scans or titlebar geometry reads: ' + JSON.stringify(result.streamingWork));
  }
  if (result.initialThemeBeforeDomReady !== true) {
    failures.push('initial theme did not reach the native window before DOM ready');
  }
  if (
    JSON.stringify(result.themeMessages) !==
    JSON.stringify([
      'dark', 'system', 'light', 'system',
    ])
  ) {
    failures.push('theme preload did not publish the expected state sequence');
  }
  if (
    JSON.stringify(result.localeMessages) !==
    JSON.stringify(['zh', 'fr-FR'])
  ) {
    failures.push('locale preload did not preserve valid Harness locales');
  }
  if (result.malformedLocaleError !== '') {
    failures.push('malformed locale interrupted the renderer event chain');
  }
  if (result.messagesAfterAuthoritativeDomChange !== 2) {
    failures.push('DOM observer overrode the authoritative Harness theme');
  }
  if (
    result.initialThemeSource !== 'dark' ||
    result.systemThemeSource !== 'system' ||
    result.updatedSystemThemeSource !== 'system'
  ) {
    failures.push('nativeTheme did not preserve the Harness system preference');
  }
  if (
    result.activeBackgroundAlpha !== 0 ||
    result.restoredBackgroundAlpha !== 0 ||
    result.restoredBackground !== result.activeBackground
  ) {
    failures.push('active New Session did not preserve the transparent fill');
  }
  if (
    result.heroBackgroundAlpha !== 0 ||
    result.settlingBackgroundAlpha !== 0
  ) {
    failures.push('blank New Session did not match the transparent sidebar');
  }
  if (!result.composerMarker) {
    failures.push('desktop surface did not mark the composer actions');
  }
  if (result.addBackground !== 'rgb(255, 255, 255)') {
    failures.push('desktop surface changed the Harness composer add background');
  }
  if (result.primaryBackground !== 'rgb(57, 100, 254)') {
    failures.push('desktop surface changed the Harness composer primary background');
  }
  if (result.toggleClicks !== 1) {
    failures.push('sidebar toggle click was intercepted by the drag region');
  }
  if (result.sessionActionClicks !== 1) {
    failures.push('conversation header action was intercepted by the drag region');
  }
  if (
    !result.detailsHandleMarker ||
    result.detailsHandleAppRegion !== 'no-drag' ||
    result.detailsHandleMouseDowns !== 1
  ) {
    failures.push('details resize handle was intercepted by the drag region');
  }
  if (
    result.sessionTitleAppRegion !== 'no-drag' ||
    result.sessionTitleUserSelect !== 'text' ||
    result.selectedSessionTitle !== 'Session title'
  ) {
    failures.push('conversation header text is not safely selectable');
  }
  if (result.platform !== 'darwin') {
    failures.push('preload did not enable DSH native macOS titlebar behavior');
  }
  if (result.surfaceKind !== 'macos') {
    failures.push('preload did not advertise the native macOS surface');
  }
  if (
    result.disposedSurface.marker ||
    result.disposedSurface.resizeHandleMarker ||
    result.disposedSurface.style
  ) {
    failures.push('desktop surface lifecycle did not release markers and styles');
  }
  if (result.disposedSurface.conversationHeaderRegion !== 'drag') {
    failures.push('Minke surface disposal interfered with DSH native window drag');
  }
  if (failures.length > 0) throw new Error(failures.join('; '));
}

run().catch((error) => {
  console.error(error);
  app.exit(1);
});
