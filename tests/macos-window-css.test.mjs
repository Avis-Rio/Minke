import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import {
  hasMacOSDesktopSurface,
} from "@minke/harness-overlay/client/desktop/index.ts";
import {
  inspectCssContract,
} from "./support/css-contract.mjs";

const macOSWindowSource = readFileSync(
  new URL("../desktop/main/macos-window.ts", import.meta.url),
  "utf8",
);
const mainWindowSource = readFileSync(
  new URL("../desktop/main/main-window.ts", import.meta.url),
  "utf8",
);
const applicationSource = readFileSync(
  new URL("../desktop/main/application.ts", import.meta.url),
  "utf8",
);
const desktopMainSource =
  `${mainWindowSource}\n${applicationSource}`;
const forgeSource = readFileSync(
  new URL("../forge.config.ts", import.meta.url),
  "utf8",
);
const desktopPreloadSource = readFileSync(
  new URL("../desktop/preload/desktop-preload.ts", import.meta.url),
  "utf8",
);
const earlyCss = readFileSync(
  new URL(
    "../resources/desktop-style-extension/early.css",
    import.meta.url,
  ),
  "utf8",
);
const desktopSurfaceSource = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/desktop/surface.ts",
    import.meta.url,
  ),
  "utf8",
);
const desktopSurfaceCss = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/desktop/surface.css",
    import.meta.url,
  ),
  "utf8",
);
const overlayBridgeSource = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/desktop/window.ts",
    import.meta.url,
  ),
  "utf8",
);
const desktopInstallSource = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/desktop/install.ts",
    import.meta.url,
  ),
  "utf8",
);
const overlayClientSource = readFileSync(
  new URL(
    "../packages/harness-overlay/src/client/index.tsx",
    import.meta.url,
  ),
  "utf8",
);
const overlayCompositionSource = [
  overlayClientSource,
  desktopInstallSource,
  ...[
    "about/install.tsx",
    "data-home/install.tsx",
    "local-model/install.ts",
    "onboarding/install.tsx",
    "shortcuts/install.tsx",
    "tabs/install.tsx",
  ].map((path) =>
    readFileSync(
      new URL(
        `../packages/harness-overlay/src/client/${path}`,
        import.meta.url,
      ),
      "utf8",
    ),
  ),
].join("\n");
const harnessSidebarCss = readFileSync(
  new URL(
    "../vendor/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.module.css",
    import.meta.url,
  ),
  "utf8",
);
const harnessConversationCss = readFileSync(
  new URL(
    "../vendor/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css",
    import.meta.url,
  ),
  "utf8",
);
const harnessSidebarSource = readFileSync(
  new URL(
    "../vendor/deepseek-harness/packages/client/ui-sidebar/src/client/SidebarRoot.tsx",
    import.meta.url,
  ),
  "utf8",
);
const harnessDesktopSurfaceSources = [
  "packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx",
  "packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx",
  "packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx",
].map((path) =>
  readFileSync(
    new URL(`../vendor/deepseek-harness/${path}`, import.meta.url),
    "utf8",
  ),
);
test("Electron keeps the native bootstrap off the persistent default Session", () => {
  assert.doesNotMatch(
    `${macOSWindowSource}\n${desktopMainSource}`,
    /insertCSS|did-finish-load|MACOS_GLASS_CSS/,
  );
  assert.doesNotMatch(
    desktopMainSource,
    /session\.defaultSession|extensions\.loadExtension/,
    "startup must not create Chromium's persistent default Session",
  );
  assert.match(
    desktopMainSource,
    /session:\s*this\.#surfaceSession/,
    "the Harness window must use the in-memory surface Session",
  );
  assert.doesNotMatch(
    earlyCss,
    /data-dsh-desktop-|MutationObserver|requestAnimationFrame/,
    "post-boot DOM adaptation belongs to the Harness overlay",
  );
});

test("Electron wires native desktop capabilities through preload", () => {
  assert.match(
    forgeSource,
    /entry:\s*"desktop\/preload\/desktop-preload\.ts"[\s\S]*target:\s*"preload"/,
  );
  assert.match(
    desktopMainSource,
    /preload:\s*join\(__dirname,\s*"desktop-preload\.js"\)/,
  );
  assert.match(desktopMainSource, /bindWindowTheme\(window,\s*nativeTheme,\s*authorizeWindow\)/);
  assert.match(desktopPreloadSource, /new MutationObserver/);
  assert.match(
    desktopPreloadSource,
    /attributeFilter:\s*\[WINDOW_THEME_SOURCE_ATTRIBUTE\]/,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.send\(WINDOW_THEME_CHANNEL,\s*source\)/,
  );
  assert.doesNotMatch(desktopPreloadSource, /data-ds-theme-preference/);
  assert.match(
    desktopPreloadSource,
    /const surface = Object\.freeze\([\s\S]*kind:[\s\S]*"macos"/,
  );
  assert.match(
    desktopPreloadSource,
    /const about = Object\.freeze\(\{[\s\S]*productName:\s*appManifest\.productName[\s\S]*version:\s*appManifest\.version[\s\S]*platform:\s*process\.platform[\s\S]*arch:\s*process\.arch/u,
  );
  assert.match(
    desktopPreloadSource,
    /Object\.freeze\(\{\s*agentBrowser,\s*appUpdate,\s*about,\s*browser,\s*dataHome,\s*files,\s*modelRuntime,\s*pluginRecovery,\s*remote,\s*remoteHub,\s*tabs,\s*terminal,\s*webSearch,\s*surface,\s*\}\)/,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*MODEL_RUNTIME_SETTINGS_READ_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /subscribeShortcut<DesktopShortcutInput>\(SHORTCUT_IPC\.input/,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.off\(channel, handle\)/,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TABS_FILES_LIST_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TABS_FILES_DIFF_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TABS_FILES_PREVIEW_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TABS_FILES_WRITE_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TABS_FILES_VIEW_STATE_READ_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TABS_FILES_VIEW_STATE_WRITE_CHANNEL/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(TERMINAL_SETTINGS_READ_CHANNEL\)/u,
  );
  assert.match(
    desktopPreloadSource,
    /ipcRenderer\.invoke\(\s*TERMINAL_SETTINGS_WRITE_CHANNEL/u,
  );
  assert.match(desktopMainSource, /bindTerminalSettingsIpc\(/u);
  assert.match(
    desktopMainSource,
    /fileSystemRoot:\s*parse\(app\.getPath\("home"\)\)\.root/u,
  );
  assert.match(
    desktopMainSource,
    /minkeConfigPath:\s*minkeConfigFilePath\(/u,
  );
  assert.match(overlayBridgeSource, /hasMacOSDesktopSurface/);
});

test("the product overlay owns post-boot desktop adaptation", () => {
  assert.doesNotMatch(
    [harnessSidebarSource, ...harnessDesktopSurfaceSources].join("\n"),
    /data-dsh-desktop-/,
  );
  assert.match(
    desktopSurfaceSource,
    /querySelector\(":scope > button:last-of-type"\)/,
  );
  assert.match(
    desktopSurfaceSource,
    /querySelector\(\s*':scope > \[data-slot="sidebar"\]'\s*,?\s*\)/,
  );
  assert.match(
    desktopSurfaceSource,
    /querySelector\(\s*':scope > \[data-slot="rightbar"\]'\s*,?\s*\)/,
  );
  assert.doesNotMatch(
    desktopSurfaceSource,
    /sidebarColumn\?\.firstElementChild/,
    "the sidebar slot wrapper must be unwrapped before locating its root",
  );
  assert.match(desktopSurfaceSource, /nextElementSibling/);
  assert.match(desktopSurfaceSource, /\[data-shell-overlay\]/);
  assert.match(desktopSurfaceSource, /children\.item\(2\)/);
  assert.match(desktopSurfaceSource, /linear-gradient/);
  assert.match(
    desktopSurfaceSource,
    /toggleAttribute\("data-dsh-desktop-sidebar-toggle"/,
  );
  assert.match(
    desktopSurfaceSource,
    /toggleAttribute\("data-dsh-desktop-new-session"/,
  );
  assert.match(desktopSurfaceSource, /new view\.MutationObserver/);
  assert.match(desktopSurfaceSource, /observer\.disconnect\(\)/);
  assert.match(desktopSurfaceSource, /cancelAnimationFrame/);
  assert.match(desktopSurfaceSource, /disposeStyles\(\)/);
  assert.match(
    desktopInstallSource,
    /hasMacOSDesktopSurface\(\)[\s\S]*ctx\.effect\([\s\S]*installDesktopSurface\(\)/,
  );
  assert.match(
    desktopInstallSource,
    /minke-overlay: macOS desktop surface/,
  );
});

test("the overlay composes around upstream slots instead of replacing shells", () => {
  assert.doesNotMatch(
    overlayCompositionSource,
    /ctx\.slots\.(?:inject|register)\(\s*["'](?:sidebar|conversation|details)["']/,
  );
});

test("macOS glass leaves shared Harness component tokens untouched", () => {
  assert.doesNotMatch(desktopSurfaceCss, /--dsw-[\w-]+\s*:/);
  assert.doesNotMatch(earlyCss, /--dsw-[\w-]+\s*:/);
});

test("macOS glass keeps the conversation column on its upstream theme surface", () => {
  assert.match(earlyCss, /html,\s*body,\s*#root/);
  assert.match(earlyCss, /\[data-shell-overlay\]/);
  assert.doesNotMatch(
    earlyCss,
    /#root :has\(> \[data-conversation-scroll\]\)/,
    "the main content column and its scrollbar gutter must keep one background",
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-dsh-desktop-titlebar-anchor\]/,
  );
  assert.doesNotMatch(`${earlyCss}\n${desktopSurfaceCss}`, /rgb\(/);
});

test("only macOS New Session makes the content background transparent", () => {
  const heroSurface = desktopSurfaceCss.match(
    /\[data-phase="hero"\]\s*\{([\s\S]*?)\}/,
  )?.[1];
  assert.ok(heroSurface, "the New Session surface override must exist");
  assert.match(
    heroSurface,
    /background:\s*transparent\s*!important/,
  );
  assert.doesNotMatch(
    desktopSurfaceCss,
    /\[data-phase="(?:active|settling)"\]\s*\{[^}]*background:\s*transparent/,
    "existing and unresolved sessions must keep the upstream surface",
  );
  assert.match(
    harnessConversationCss,
    /\.root\s*\{[\s\S]*background:\s*var\(--dsw-alias-bg-base\);/,
    "non-New-Session content must fall back to the Harness default",
  );
  assert.equal(
    hasMacOSDesktopSurface({
      minkeDesktop: { surface: { kind: "macos" } },
    }),
    true,
  );
  assert.equal(
    hasMacOSDesktopSurface({
      minkeDesktop: { surface: { kind: "standard" } },
    }),
    false,
  );
  assert.equal(hasMacOSDesktopSurface({}), false);
  assert.match(
    desktopInstallSource,
    /if \(hasMacOSDesktopSurface\(\)\) \{[\s\S]*installDesktopSurface\(\)/,
    "Windows and Linux must not install the macOS transparency stylesheet",
  );
});

test("macOS New Session keeps the composer boundary on its transparent surface", () => {
  const contract = inspectCssContract(desktopSurfaceCss);
  const selector = '[data-phase="hero"] [data-composer-card]';
  assert.equal(
    contract.declaration(selector, "background-color"),
    "transparent !important",
    "the blank-session composer must keep the macOS glass surface",
  );
  assert.equal(
    contract.declaration(selector, "box-shadow"),
    "var(--dsw-elevation-stroke) !important",
    "the transparent card still needs the shared 0.5px input boundary",
  );
});

test("macOS window controls use Electron and AppKit defaults", () => {
  assert.doesNotMatch(macOSWindowSource, /trafficLightPosition/);
  assert.doesNotMatch(desktopMainSource, /bindMacOSWindowButtonSpacing|macos-window-controls/);
});

test("the desktop sidebar toggle keeps one stable glyph across hover", () => {
  assert.match(
    desktopSurfaceSource,
    /data-dsh-desktop-sidebar-toggle/,
  );
  assert.doesNotMatch(
    desktopSurfaceCss,
    /\[data-dsh-desktop-titlebar-anchor\][\s\S]*button:only-child/,
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-dsh-desktop-sidebar-toggle\]\s*>\s*svg\s*\{[^}]*display:\s*inline\s*!important/,
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-sidebar-collapsed\]\s+\[data-dsh-desktop-sidebar-toggle\]\s*>\s*span\[aria-hidden="true"\]\s*\{[^}]*display:\s*none\s*!important/,
    "the collapsed desktop rail must hide the whale mark and show only the sidebar glyph",
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-sidebar-collapsed\] \[data-dsh-desktop-sidebar-toggle\]\s*\{[^}]*animation:\s*none\s*!important;[^}]*transform:\s*none\s*!important;/,
    "hover-driven rerenders must not restart Harness's rail-in slide",
  );
});

test("the collapsed desktop sidebar glyph stays visible before hover with a native badge slot", () => {
  const dom = new JSDOM(`<!doctype html>
    <div data-sidebar-collapsed="true">
      <div class="root collapsed">
        <div data-dsh-desktop-titlebar-anchor>
          <button class="iconButton toggle" data-dsh-desktop-sidebar-toggle>
            <span class="railMark" aria-hidden="true"><svg></svg></span>
            <svg class="panelIcon"></svg>
            <div data-slot="sidebar.toggle.badge" style="display: contents">
              <span role="img" aria-label="Update available"></span>
            </div>
          </button>
        </div>
      </div>
    </div>`);
  try {
    const { document, getComputedStyle } = dom.window;
    const nativeStyle = document.createElement("style");
    nativeStyle.textContent = harnessSidebarCss;
    document.head.append(nativeStyle);
    const glyph = document.querySelector(".panelIcon");
    assert.equal(getComputedStyle(glyph).display, "none", "DSH swaps the collapsed glyph on hover by default");
    const desktopStyle = document.createElement("style");
    desktopStyle.textContent = desktopSurfaceCss;
    document.head.append(desktopStyle);
    assert.equal(getComputedStyle(glyph).display, "inline", "the badge slot must not hide Minke's resting expand glyph");
    assert.equal(getComputedStyle(document.querySelector(".railMark")).display, "none");
    assert.notEqual(getComputedStyle(document.querySelector('[role="img"]')).display, "none", "native status badges remain available");
  } finally {
    dom.window.close();
  }
});

test("the desktop New Session button stays fully transparent in every state", () => {
  assert.match(
    desktopSurfaceSource,
    /toggleAttribute\("data-dsh-desktop-frame"/,
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-dsh-desktop-new-session\]\s*\{[\s\S]*?background:\s*transparent\s*!important;/,
  );
  assert.match(
    harnessSidebarCss,
    /\.newSession\s*\{[\s\S]*?background:\s*var\(--dsw-alias-button-elevated-fill\);/,
    "the macOS-only override must leave the shared Harness material unchanged",
  );
  assert.doesNotMatch(
    desktopSurfaceCss,
    /data-dsh-desktop-new-session[^\{]*:(?:hover|active)[\s\S]*?\{[\s\S]*?background:/,
    "interaction states must not reintroduce a fill",
  );
});

test("macOS New Session uses quieter composer action colors", () => {
  assert.match(
    desktopSurfaceSource,
    /data-dsh-desktop-composer-add/,
    "the overlay must mark the add action without relying on localized labels",
  );
  assert.match(
    desktopSurfaceSource,
    /data-dsh-desktop-composer-primary/,
    "the overlay must mark the primary action without relying on localized labels",
  );
  assert.match(desktopSurfaceSource, /markComposerActions/);
  assert.match(
    desktopSurfaceCss,
    /\[data-phase="hero"\]\s+\[data-dsh-desktop-composer-add\],[\s\S]*?\[data-phase="hero"\]\s+\[data-dsh-desktop-composer-primary\]\s*\{[\s\S]*?background:\s*var\(--dsw-alias-interactive-bg-active\)\s*!important;/,
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-phase="hero"\]\s+\[data-dsh-desktop-composer-primary\]\s*\{[\s\S]*?color:\s*var\(--dsw-alias-state-business-primary\)\s*!important;/,
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-phase="hero"\]\s+\[data-dsh-desktop-composer-add\]:hover:not\(:disabled\),[\s\S]*?\[data-phase="hero"\]\s+\[data-dsh-desktop-composer-primary\]:hover:not\(:disabled\)\s*\{[\s\S]*?background:\s*var\(--dsw-alias-interactive-bg-hover-accent\)\s*!important;/,
  );
  assert.doesNotMatch(
    desktopSurfaceCss,
    /\[data-phase="active"\][\s\S]*?data-dsh-desktop-composer-(?:add|primary)/,
    "existing sessions must keep the upstream composer action colors",
  );
  assert.doesNotMatch(earlyCss, /data-dsh-desktop-composer-/);
});

// Native rectangle composition and menu interactions are exercised against the
// production renderer in window-drag-ui.cjs / native-sidebar-ui.cjs.

test("the active composer restores its upstream theme surfaces", () => {
  assert.match(earlyCss, /\[data-conversation-composer-overlay\]/);
  assert.match(
    desktopSurfaceCss,
    /\[data-dsh-desktop-base-surface\]/,
  );
  assert.match(
    desktopSurfaceCss,
    /\[data-dsh-desktop-sidebar-fade\]/,
  );
  assert.doesNotMatch(
    earlyCss,
    /\[data-composer-(?:seat|card)\]/,
    "document-start CSS must not erase the upstream composer materials",
  );
  const activeCard = desktopSurfaceCss.match(
    /\[data-phase="active"\] \[data-composer-card\]\s*\{([\s\S]*?)\}/,
  )?.[1];
  assert.ok(activeCard, "the active input card must restore its theme surface");
  assert.match(
    activeCard,
    /background:\s*var\(--dsw-specific-input-major\)\s*!important/,
  );
  assert.doesNotMatch(activeCard, /backdrop-filter|color-mix/);
  assert.doesNotMatch(
    desktopSurfaceCss,
    /conversation\.composer\.dock/,
    "the stats row must inherit the continuous conversation surface",
  );
  assert.doesNotMatch(
    desktopSurfaceCss,
    /composer-material|height:\s*200%|mask-image/,
    "the composer must not inject or emulate a second material tree",
  );
});
