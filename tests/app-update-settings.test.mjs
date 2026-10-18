import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  bindAppUpdateSettingsIpc,
} from "@minke/desktop/main/app-update-settings.ts";
import {
  shouldConfirmUpdateDownload,
} from "@minke/desktop/main/app-update.ts";
import {
  MINKE_CONFIG_VERSION,
  MinkeConfigStore,
} from "@minke/desktop/main/minke-config.ts";
import {
  APP_UPDATE_SETTINGS_READ_CHANNEL,
  APP_UPDATE_SETTINGS_WRITE_CHANNEL,
  DEFAULT_APP_UPDATE_SETTINGS,
  parseAppUpdateSettings,
} from "@minke/harness-overlay/app-update-contract.ts";
import {
  desktopAppUpdateSettingsStore,
} from "@minke/harness-overlay/client/desktop/settings.ts";
import {
  AppUpdateSettingsRuntime,
} from "@minke/harness-overlay/client/preferences/app-update-runtime.ts";
import {
  preferencesEn,
  preferencesZh,
} from "@minke/harness-overlay/client/preferences/locales.ts";
import {
  AboutPanel,
} from "@minke/harness-overlay/client/about/view.tsx";
import {
  zh as aboutZh,
} from "@minke/harness-overlay/client/about/locales.ts";

const roots = [];

async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "minke-app-update-settings-"),
  );
  roots.push(root);
  const config = new MinkeConfigStore(root);
  return {
    config,
    path: config.path,
    store: config.appUpdate,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(
      async (root) =>
        await rm(root, { recursive: true, force: true }),
    ),
  );
});

test("app update settings use one exact boolean contract", () => {
  assert.deepEqual(DEFAULT_APP_UPDATE_SETTINGS, {
    autoDownload: true,
  });
  assert.deepEqual(
    parseAppUpdateSettings({ autoDownload: false }),
    { autoDownload: false },
  );
  assert.throws(
    () => parseAppUpdateSettings({ autoDownload: "yes" }),
    /app update settings/u,
  );
  assert.throws(
    () =>
      parseAppUpdateSettings({
        autoDownload: true,
        installWithoutPrompt: true,
      }),
    /app update settings/u,
  );
});

test("app update preference persists in the unified Minke config", async () => {
  const { path, store } = await fixture();
  assert.deepEqual(
    await store.read(),
    DEFAULT_APP_UPDATE_SETTINGS,
  );

  await store.write({ autoDownload: false });
  assert.deepEqual(await store.read(), {
    autoDownload: false,
  });
  const document = JSON.parse(await readFile(path, "utf8"));
  assert.equal(document.version, MINKE_CONFIG_VERSION);
  assert.deepEqual(document.appUpdate, {
    autoDownload: false,
  });
});

test("app update settings IPC authorizes writes and applies them live", async () => {
  const { store } = await fixture();
  const handlers = new Map();
  const applied = [];
  let allowPersistence = () => {};
  const persistenceGate = new Promise((resolve) => {
    allowPersistence = resolve;
  });
  const binding = bindAppUpdateSettingsIpc(
    {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    {
      read: () => store.read(),
      async write(value) {
        await persistenceGate;
        await store.write(value);
      },
    },
    (settings) => {
      applied.push(settings);
    },
    (event) => event === "allowed",
  );

  const write = handlers.get(APP_UPDATE_SETTINGS_WRITE_CHANNEL)(
    "allowed",
    { autoDownload: false },
  );
  assert.deepEqual(applied, [{ autoDownload: false }]);
  allowPersistence();
  await write;
  assert.deepEqual(
    await handlers.get(APP_UPDATE_SETTINGS_READ_CHANNEL)("allowed"),
    { autoDownload: false },
  );
  await assert.rejects(
    handlers.get(APP_UPDATE_SETTINGS_READ_CHANNEL)("denied"),
    /unauthorized/u,
  );
  await assert.rejects(
    handlers.get(APP_UPDATE_SETTINGS_WRITE_CHANNEL)("denied", { autoDownload: true }),
    /unauthorized/u,
  );

  binding.dispose();
  binding.dispose();
  assert.equal(handlers.size, 0);
});

test("desktop update settings bridge hydrates and persists the Settings toggle", async () => {
  let settings = { autoDownload: true };
  const store = desktopAppUpdateSettingsStore({
    minkeDesktop: {
      appUpdate: {
        async read() {
          return settings;
        },
        async write(value) {
          settings = parseAppUpdateSettings(value);
        },
      },
    },
  });
  const runtime = new AppUpdateSettingsRuntime(store);

  await runtime.initialize();
  assert.equal(runtime.getSnapshot().editable, true);
  assert.equal(
    runtime.getSnapshot().settings.autoDownload,
    true,
  );
  runtime.setAutoDownload(false);
  assert.equal(
    runtime.getSnapshot().settings.autoDownload,
    false,
  );
  await runtime.flush();
  assert.deepEqual(settings, { autoDownload: false });
  runtime.dispose();
});

test("About exposes only a localized entry to the standard update action", () => {
  const t = (key, params) =>
    aboutZh[key].replace(/\{(\w+)\}/gu, (match, name) =>
      params !== undefined && Object.hasOwn(params, name)
        ? String(params[name])
        : match,
    );
  const html = renderToStaticMarkup(
    createElement(AboutPanel, {
      openUpdates() {},
      iconUrl: "data:image/png;base64,AA==",
      info: {
        available: true,
        productName: "Minke",
        version: "0.2.0",
        platform: "linux",
        arch: "x64",
      },
      onClose() {},
      openExternal() {},
      t,
    }),
  );
  assert.equal(html.includes("检查更新"), true);
  assert.equal(html.includes('role="status"'), false, "DSH owns update presentation");
  assert.match(html, /<button[^>]*data-minke-about-update-check[^>]*>检查更新<\/button>/u);
});

test("personal preferences localize the automatic update download control", () => {
  assert.equal(
    preferencesZh["preferences.update.title"],
    "软件更新",
  );
  assert.equal(
    preferencesZh["preferences.update.autoDownload.label"],
    "自动下载更新",
  );
  assert.equal(
    preferencesEn["preferences.update.autoDownload.label"],
    "Download updates automatically",
  );
});

test("disabling automatic downloads requires an explicit download choice", () => {
  assert.equal(shouldConfirmUpdateDownload(true), false);
  assert.equal(shouldConfirmUpdateDownload(false), true);
});
