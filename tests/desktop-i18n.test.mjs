import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  desktopDictionaries,
  DesktopLocaleRuntime,
  translateDesktop,
} from "@minke/desktop/i18n.ts";
import {
  isDesktopLocale,
  resolveDesktopLocale,
  WINDOW_LOCALE_CHANNEL,
  WINDOW_LOCALE_BOOTSTRAP_CHANNEL,
} from "@minke/desktop/locale-contract.ts";
import {
  bindWindowLocale,
  readHarnessLocaleBootstrap,
} from "@minke/desktop/main/window-locale.ts";
import {
  isHarnessLocale,
} from "@minke/harness-overlay/client/core/context.ts";

test("desktop locale follows app.getLocale semantics and falls back to en", () => {
  assert.equal(resolveDesktopLocale("zh-CN"), "zh");
  assert.equal(resolveDesktopLocale("zh-Hant-TW"), "zh");
  assert.equal(resolveDesktopLocale("ZH_hant"), "zh");
  assert.equal(resolveDesktopLocale("en-US"), "en");
  assert.equal(resolveDesktopLocale("fr-FR"), "en");
  assert.equal(resolveDesktopLocale(""), "en");
  assert.equal(resolveDesktopLocale(undefined), "en");
});

test("desktop locale boundaries accept BCP 47-style language-pack ids", () => {
  for (const locale of [
    "fr",
    "fr-FR",
    "zh-Hant-TW",
    "de-DE-u-co-phonebk",
  ]) {
    assert.equal(isHarnessLocale(locale), true, locale);
    assert.equal(isDesktopLocale(locale), true, locale);
  }
  for (const locale of [
    "",
    "ZH_hant",
    "en-abcdefghi",
    "9n",
    null,
    {},
  ]) {
    assert.equal(isHarnessLocale(locale), false, String(locale));
    assert.equal(isDesktopLocale(locale), false, String(locale));
  }
});

test("desktop dictionaries are complete and interpolate native details", () => {
  assert.deepEqual(
    Object.keys(desktopDictionaries.en).sort(),
    Object.keys(desktopDictionaries.zh).sort(),
  );
  for (const dictionary of Object.values(desktopDictionaries)) {
    for (const value of Object.values(dictionary)) {
      assert.equal(typeof value, "string");
      assert.notEqual(value.trim(), "");
    }
  }

  assert.equal(
    translateDesktop("zh", "recovery.report", { path: "/tmp/report.log" }),
    "诊断文件：/tmp/report.log",
  );
  assert.equal(
    translateDesktop("en", "recovery.report", { path: "/tmp/report.log" }),
    "Diagnostic file: /tmp/report.log",
  );
  assert.equal(
    translateDesktop("zh", "sessionExport.saveDialogTitle"),
    "导出 Session 日志",
  );
  assert.equal(
    translateDesktop("en", "sessionExport.failedTitle"),
    "Unable to export Session log",
  );
  assert.equal(
    translateDesktop("zh-Hant-TW", "bootstrap.loading"),
    "正在启动 Minke",
  );
  assert.equal(
    translateDesktop("fr-FR", "bootstrap.loading"),
    "Starting Minke",
  );
});

test("desktop locale runtime preserves language-pack ids and projects native copy", () => {
  const runtime = new DesktopLocaleRuntime("fr-FR");
  assert.deepEqual(runtime.getSnapshot(), {
    active: "fr-FR",
    revision: 0,
  });
  assert.equal(runtime.t("bootstrap.loading"), "Starting Minke");

  runtime.setLocale("zh-Hant");
  assert.deepEqual(runtime.getSnapshot(), {
    active: "zh-Hant",
    revision: 1,
  });
  assert.equal(runtime.t("bootstrap.loading"), "正在启动 Minke");

  runtime.setLocale("not_a_tag");
  assert.equal(runtime.getSnapshot().active, "zh-Hant");
  assert.equal(runtime.getSnapshot().revision, 1);
});

test("only authorized, valid Harness locale messages update desktop state", async () => {
  const ipc = localeIpc();
  const runtime = new DesktopLocaleRuntime("en");
  const binding = bindWindowLocale(
    { webContents: { ipc } },
    runtime,
    (event) => event === "allowed",
    async () => ({ languages: ["zh-Hant", "en"], preference: "fr-FR" }),
  );
  await assert.rejects(ipc.handlers.get(WINDOW_LOCALE_BOOTSTRAP_CHANNEL)("denied"), /unauthorized/);
  assert.deepEqual(await ipc.handlers.get(WINDOW_LOCALE_BOOTSTRAP_CHANNEL)("allowed"), { languages: ["zh-Hant", "en"], preference: "fr-FR" });
  let notifications = 0;
  const unsubscribe = runtime.subscribe(() => {
    notifications += 1;
  });

  ipc.emit(WINDOW_LOCALE_CHANNEL, "denied", "zh");
  ipc.emit(WINDOW_LOCALE_CHANNEL, "allowed", "fr_FR");
  assert.equal(runtime.getSnapshot().active, "en");
  assert.equal(notifications, 0);

  ipc.emit(WINDOW_LOCALE_CHANNEL, "allowed", "fr-FR");
  assert.deepEqual(runtime.getSnapshot(), {
    active: "fr-FR",
    revision: 1,
  });
  assert.equal(runtime.t("bootstrap.loading"), "Starting Minke");
  assert.equal(notifications, 1);

  ipc.emit(WINDOW_LOCALE_CHANNEL, "allowed", "zh-Hant");
  assert.deepEqual(runtime.getSnapshot(), {
    active: "zh-Hant",
    revision: 2,
  });
  assert.equal(
    runtime.t("bootstrap.loading"),
    "正在启动 Minke",
  );
  assert.equal(notifications, 2);

  binding.dispose();
  binding.dispose();
  ipc.emit(WINDOW_LOCALE_CHANNEL, "allowed", "en");
  assert.equal(runtime.getSnapshot().active, "zh-Hant");
  assert.equal(ipc.listenerCount(WINDOW_LOCALE_CHANNEL), 0);
  assert.equal(ipc.handlers.size, 0);
  unsubscribe();
});

test("locale binding can dispose after its BrowserWindow is destroyed", () => {
  const ipc = localeIpc();
  let destroyed = false;
  const window = {
    get webContents() {
      if (destroyed) throw new TypeError("Object has been destroyed");
      return { ipc };
    },
  };
  const runtime = new DesktopLocaleRuntime("en");
  const binding = bindWindowLocale(window, runtime, () => true, async () => ({ languages: ["en"], preference: null }));

  destroyed = true;
  assert.doesNotThrow(() => binding.dispose());
  assert.equal(ipc.listenerCount(WINDOW_LOCALE_CHANNEL), 0);
  assert.equal(ipc.handlers.size, 0);
});

function localeIpc() {
  const ipc = new EventEmitter();
  ipc.handlers = new Map();
  ipc.handle = (channel, listener) => ipc.handlers.set(channel, listener);
  ipc.removeHandler = channel => ipc.handlers.delete(channel);
  return ipc;
}

test("native locale bootstrap reads DSH settings without saving a second preference", async () => {
  for (const preference of [undefined, "fr-FR"]) {
    const requests = [];
    const bootstrap = await readHarnessLocaleBootstrap("http://127.0.0.1:4321", ["zh-Hant", "en-US"], async (url, init) => {
      requests.push({ url, init });
      const request = JSON.parse(init.body);
      assert.equal(request.method, "settings/describe");
      assert.deepEqual(request.payload, { args: {} });
      return Response.json({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: {
        namespaces: [{ ns: "locale", value: preference === undefined ? {} : { preference } }],
      } } });
    });
    assert.deepEqual(bootstrap, { languages: ["zh-Hant", "en-US"], preference: preference ?? null });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://127.0.0.1:4321/api/settings/describe");
    assert.equal(requests[0].init.credentials, "include");
    assert.equal(requests[0].init.redirect, "error");
  }
});

test("native locale bootstrap rejects failed and malformed Host responses", async () => {
  for (const namespaces of [[], [{ ns: "locale", value: { preference: 1 } }]]) {
    await assert.rejects(readHarnessLocaleBootstrap("http://127.0.0.1:4321", ["en"], async (_url, init) => {
      const request = JSON.parse(init.body);
      return Response.json({ type: "server-response", rpcId: request.rpcId,
        result: { ok: true, value: { namespaces } } });
    }), /invalid locale preference/);
  }
  await assert.rejects(readHarnessLocaleBootstrap("http://127.0.0.1:4321", ["en"], async () => new Response(null, { status: 403 })), /settings request failed/);
  await assert.rejects(readHarnessLocaleBootstrap("http://127.0.0.1:4321", ["en"], async () => Response.json({})), /invalid settings response/);
});
