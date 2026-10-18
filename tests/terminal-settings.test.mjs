import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { migrateTerminalFontProfile } from "@minke/desktop/main/profile-migration.ts";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bindTerminalSettingsIpc,
} from "@minke/desktop/main/terminal-settings.ts";
import {
  MINKE_CONFIG_VERSION,
  MinkeConfigStore,
} from "@minke/desktop/main/minke-config.ts";
import {
  DEFAULT_TERMINAL_SETTINGS,
  parseTerminalSettings,
  TERMINAL_SETTINGS_READ_CHANNEL,
  TERMINAL_SETTINGS_WRITE_CHANNEL,
} from "@minke/harness-overlay/terminal-settings-contract.ts";
import {
  TerminalSettingsRuntime,
} from "@minke/harness-overlay/client/tabs/terminal/settings/runtime.ts";
import {
  preferencesEn,
  preferencesZh,
} from "@minke/harness-overlay/client/preferences/locales.ts";
import {
  PreferencesSection,
} from "@minke/harness-overlay/client/preferences/PreferencesSection.tsx";
import {
  WebSearchSettingsRuntime,
} from "@minke/harness-overlay/client/preferences/web-search-runtime.ts";
import {
  loadTerminalCodeTheme,
  terminalCodeThemeFallback,
} from "@minke/harness-overlay/client/tabs/files/code-themes.ts";
import {
  stageDraftChange,
} from "@minke/harness-overlay/client/tabs/terminal/settings/drafts.ts";
import {
  terminalTabsEn,
  terminalTabsZh,
} from "@minke/harness-overlay/client/tabs/terminal/locales.ts";

const roots = [];

test("legacy terminal fonts migrate once without overwriting General preferences", async () => {
  const home = await mkdtemp(join(tmpdir(), "minke-terminal-migration-"));
  roots.push(home);
  const dir = join(home, "profiles", "web");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "cordis.patch.yml");
  const before = '# keep theme\n- id: ui-theme\n  config:\n    preference: dark\n    terminalFontFamily: Fira Code\n- id: unrelated\n  config:\n    expression: !!js (() => { throw new Error("never evaluate") })()\n';
  await writeFile(path, before);
  const options = { runtimeRoot: resolve("runtime/host"), dshHome: home, electronExecutable: process.execPath };
  const { parseDocument } = createRequire(join(options.runtimeRoot, "package.json"))("yaml");
  const parse = text => parseDocument(text, { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }] });
  const legacy = { fontFamily: "Monaco", fontSize: 28, lineHeight: 1.4 };
  await migrateTerminalFontProfile(options, legacy);
  const migrated = parse(await readFile(path, "utf8"));
  assert.deepEqual(migrated.getIn([0, "config"]).toJSON(), { preference: "dark", terminalFontFamily: "Fira Code", terminalFontSize: 20 });
  assert.equal(migrated.getIn([1, "config", "expression"], true).tag, "tag:yaml.org,2002:js");
  assert.equal(await readFile(path + ".before-minke-terminal-fonts", "utf8"), before);
  assert.deepEqual(JSON.parse(await readFile(join(dir, ".minke-terminal-fonts.json"), "utf8")).legacy, legacy);
  // Native reset removes the override. Restart must not import the old size again.
  await writeFile(path, "[]\n");
  await migrateTerminalFontProfile(options, legacy);
  assert.equal(await readFile(path, "utf8"), "[]\n");
});

test("font migration preserves home and dynamic settings and fresh-install defaults", async () => {
  for (const mode of ["home", "dynamic", "fresh", "small"]) {
    const home = await mkdtemp(join(tmpdir(), "minke-terminal-migration-"));
    roots.push(home);
    const dir = join(home, "profiles", "web");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "cordis.patch.yml");
    const before = mode === "dynamic" ? '- id: ui-theme\n  config: !!js |\n    ({ terminalFontSize: 17 })\n' : '[]\n';
    await writeFile(path, before);
    if (mode === "home") await writeFile(join(home, "cordis.patch.yml"), '- id: ui-theme\n  config:\n    terminalFontSize: 19\n');
    const options = { runtimeRoot: resolve("runtime/host"), dshHome: home, electronExecutable: process.execPath };
    const legacy = { fontFamily: "monospace", fontSize: 8, lineHeight: 1.2 };
    await migrateTerminalFontProfile(options, mode === "fresh" ? undefined : legacy);
    if (mode === "small") {
      const { parse } = createRequire(join(options.runtimeRoot, "package.json"))("yaml");
      assert.deepEqual(parse(await readFile(path, "utf8"))[0].config, { terminalFontFamily: "monospace", terminalFontSize: 10 });
    } else assert.equal(await readFile(path, "utf8"), before);
    await migrateTerminalFontProfile(options, legacy);
    if (mode === "fresh") assert.equal(await readFile(path, "utf8"), before);
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "minke-terminal-settings-"));
  roots.push(root);
  const config = new MinkeConfigStore(root);
  return {
    path: config.path,
    store: config.terminal,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

function assertDefaultRemoteSettings(settings) {
  assert.match(
    settings.cloudflare.generatedLabel,
    /^m-[0123456789abcdefghjkmnpqrstvwxyz]{16}$/u,
  );
  assert.deepEqual(settings, {
    enabled: false,
    method: "tailscale",
    tailscale: {
      transport: "serve",
      ipAddress: "",
    },
    cloudflare: {
      hostnameMode: "generated",
      domain: "",
      generatedLabel:
        settings.cloudflare.generatedLabel,
      customHostname: "",
      teamName: "",
      audience: "",
      tunnel: "",
      configPath: "",
      originPort: 49_321,
    },
  });
}

test("Terminal settings validate a small, exact rendering contract", () => {
  assert.deepEqual(
    parseTerminalSettings({
      fontFamily: "  JetBrains Mono, monospace  ",
      fontSize: 14,
      lineHeight: 1.35,
    }),
    {
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 14,
      lineHeight: 1.35,
    },
  );
  assert.throws(
    () => parseTerminalSettings({
      ...DEFAULT_TERMINAL_SETTINGS,
      fontSize: 7,
    }),
    /font size/u,
  );
  assert.throws(
    () => parseTerminalSettings({
      ...DEFAULT_TERMINAL_SETTINGS,
      lineHeight: 2.01,
    }),
    /line height/u,
  );
  assert.throws(
    () => parseTerminalSettings({
      ...DEFAULT_TERMINAL_SETTINGS,
      fontFamily: "Monaco\nserif",
    }),
    /font family/u,
  );
  assert.throws(
    () => parseTerminalSettings({
      ...DEFAULT_TERMINAL_SETTINGS,
      futureOption: true,
    }),
    /terminal settings/u,
  );
});

test("Preferences copy stays complete in English and Chinese", () => {
  assert.deepEqual(
    Object.keys(preferencesEn).sort(),
    Object.keys(preferencesZh).sort(),
  );
  assert.equal(preferencesZh["preferences.nav"], "偏好设置");
  assert.equal(preferencesEn["preferences.nav"], "Preferences");
  assert.equal(preferencesZh["preferences.title"], "偏好设置");
  assert.equal(
    preferencesEn["preferences.category.workspace.title"],
    "Workspace",
  );
  assert.equal(
    preferencesZh["preferences.category.application.title"],
    "应用行为",
  );
  assert.equal(
    preferencesZh["preferences.codeTheme.light.label"],
    "浅色模式",
  );
  assert.equal(
    preferencesZh["preferences.codeTheme.dark.label"],
    "深色模式",
  );
  assert.equal(
    preferencesEn["preferences.terminal.title"],
    "Terminal",
  );
  assert.equal(
    preferencesZh["preferences.code.title"],
    "代码外观",
  );
  assert.deepEqual(
    Object.keys(terminalTabsEn).sort(),
    Object.keys(terminalTabsZh).sort(),
  );
});

test("Preferences groups workspace and application settings", () => {
  const source = readFileSync(
    new URL(
      "../packages/harness-overlay/src/client/preferences/PreferencesSection.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const terminalSettings = new TerminalSettingsRuntime({
    available: false,
  });
  const webSearchSettings = new WebSearchSettingsRuntime({
    available: false,
  });
  const markup = renderToStaticMarkup(
    createElement(PreferencesSection, {
      terminalSettings,
      webSearchSettings,
      t: (key) => preferencesEn[key],
    }),
  );

  assert.match(source, /data-minke-preferences/u);
  assert.equal(
    markup.includes('data-preferences-category="workspace"'),
    true,
  );
  assert.equal(
    markup.includes('data-preferences-category="application"'),
    true,
  );
  assert.match(source, /data-minke-terminal-settings/u);
  assert.equal(markup.includes('id="minke-terminal-settings-font-size-help"'), false);
  assert.equal(markup.includes('id="minke-terminal-settings-font-family-help"'), false);
  assert.equal(markup.includes('id="minke-terminal-settings-line-height-help"'), true);
  assert.match(source, /data-appearance=\{colorScheme\}/u);
  assert.match(
    source,
    /data-code-theme=\{codeTheme\}/u,
    "the Terminal preview must expose the shared active theme",
  );
  assert.match(
    source,
    /className="minke-preferences__theme-options"/u,
  );
  assert.match(
    source,
    /CODE_THEME_GROUPS\.map\(\(group\)\s*=>\s*\(/u,
  );
  assert.match(source, /<optgroup/u);
  assert.match(source, /<CodeThemePreferences/u);
  assert.match(source, /<TerminalPreferences/u);
  terminalSettings.dispose();
  webSearchSettings.dispose();
});

test("Terminal reuses the selected editor theme including ANSI colors", async () => {
  assert.deepEqual(
    terminalCodeThemeFallback("catppuccin-mocha"),
    {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#9399b240",
    },
  );

  const mocha = await loadTerminalCodeTheme(
    "catppuccin-mocha",
  );
  assert.deepEqual(
    {
      background: mocha.background,
      foreground: mocha.foreground,
      cursor: mocha.cursor,
      selectionBackground: mocha.selectionBackground,
      red: mocha.red,
      green: mocha.green,
      yellow: mocha.yellow,
      blue: mocha.blue,
      magenta: mocha.magenta,
      cyan: mocha.cyan,
    },
    {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
    },
  );

  const solarizedLight = await loadTerminalCodeTheme(
    "solarized-light",
  );
  assert.equal(solarizedLight.background, "#FDF6E3");
  assert.equal(solarizedLight.foreground, "#657b83");
  assert.equal(solarizedLight.red, "#dc322f");
  assert.equal(solarizedLight.blue, "#268bd2");

});

test("the desktop store writes Terminal settings into Minke config", async () => {
  const { path, store } = await fixture();
  assert.deepEqual(await store.read(), DEFAULT_TERMINAL_SETTINGS);

  await store.write({
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    lineHeight: 1.35,
  });

  assert.deepEqual(await store.read(), {
    fontFamily: "JetBrains Mono",
    fontSize: 14,
    lineHeight: 1.35,
  });
  const document = JSON.parse(await readFile(path, "utf8"));
  const { remote, ...documentWithoutRemote } = document;
  assert.deepEqual(documentWithoutRemote, {
    version: MINKE_CONFIG_VERSION,
    shortcuts: {},
    terminal: {
      fontFamily: "JetBrains Mono",
      fontSize: 14,
      lineHeight: 1.35,
    },
    modelRuntime: {
      lmStudio: { enabled: false },
      ollama: { enabled: false },
    },
    plugins: {
      safeMode: false,
      disabledPlugins: [],
    },
    webSearch: {
      fallbackEnabled: true,
    },
    telegramNetwork: {
      httpProxyUrl: "",
    },
    discordNetwork: {
      httpProxyUrl: "",
    },
    appUpdate: {
      autoDownload: true,
    },
    browser: {
      webUserAgent: "",
      agentUserAgent: "",
    },
  });
  assertDefaultRemoteSettings(remote);
});

test("Terminal settings IPC authorizes and validates reads and writes", async () => {
  const { store } = await fixture();
  const handlers = new Map();
  const binding = bindTerminalSettingsIpc(
    {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    store,
    (event) => event === "allowed",
  );

  await handlers.get(TERMINAL_SETTINGS_WRITE_CHANNEL)(
    "allowed",
    {
      fontFamily: "",
      fontSize: 15,
      lineHeight: 1.4,
    },
  );
  assert.deepEqual(
    await handlers.get(TERMINAL_SETTINGS_READ_CHANNEL)("allowed"),
    {
      fontFamily: "",
      fontSize: 15,
      lineHeight: 1.4,
    },
  );
  await assert.rejects(
    handlers.get(TERMINAL_SETTINGS_WRITE_CHANNEL)(
      "allowed",
      {
        fontFamily: "",
        fontSize: 100,
        lineHeight: 1.4,
      },
    ),
    /font size/u,
  );
  await assert.rejects(
    handlers.get(TERMINAL_SETTINGS_READ_CHANNEL)("denied"),
    /unauthorized/u,
  );

  binding.dispose();
  binding.dispose();
  assert.equal(handlers.size, 0);
});

test("Terminal settings hydrate, update optimistically, and reset", async () => {
  const writes = [];
  const runtime = new TerminalSettingsRuntime({
    available: true,
    async read() {
      return {
        fontFamily: "Monaco",
        fontSize: 13,
        lineHeight: 1.3,
      };
    },
    async write(settings) {
      writes.push({ ...settings });
    },
  });

  await runtime.initialize();
  assert.deepEqual(runtime.getSnapshot().settings, {
    fontFamily: "Monaco",
    fontSize: 13,
    lineHeight: 1.3,
  });
  assert.equal(runtime.getSnapshot().editable, true);

  runtime.update({ lineHeight: 1.5 });
  assert.equal(runtime.getSnapshot().settings.lineHeight, 1.5);
  await runtime.flush();
  assert.deepEqual(writes.at(-1), {
    fontFamily: "Monaco",
    fontSize: 13,
    lineHeight: 1.5,
  });

  runtime.reset();
  await runtime.flush();
  assert.deepEqual(runtime.getSnapshot().settings, { fontFamily: "Monaco", fontSize: 13, lineHeight: DEFAULT_TERMINAL_SETTINGS.lineHeight });
  assert.deepEqual(writes.at(-1), runtime.getSnapshot().settings);
  runtime.dispose();
});

test("Terminal input changes do not retain React event.currentTarget", () => {
  let currentTarget = { value: "1.6" };
  let pendingUpdate;
  const event = {
    get currentTarget() {
      return currentTarget;
    },
  };

  stageDraftChange(
    (update) => {
      pendingUpdate = update;
    },
    "lineHeight",
    event,
  );
  currentTarget = null;

  assert.equal(typeof pendingUpdate, "function");
  assert.deepEqual(
    pendingUpdate({
      lineHeight: "1.24",
    }),
    {
      lineHeight: "1.6",
    },
  );
});

test("Terminal persistence failures remain observable", async () => {
  const runtime = new TerminalSettingsRuntime({
    available: true,
    async read() {
      return DEFAULT_TERMINAL_SETTINGS;
    },
    async write() {
      throw new Error("disk full");
    },
  });
  await runtime.initialize();

  runtime.update({ lineHeight: 1.6 });
  await runtime.flush();
  assert.equal(runtime.getSnapshot().error, "write");
  runtime.dispose();
});
