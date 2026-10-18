import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, test } from "node:test";
import {
  act,
  createElement,
} from "react";
import {
  renderToStaticMarkup,
} from "react-dom/server";
import {
  JSDOM,
} from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import {
  bindModelRuntimeSettingsIpc,
} from "@minke/desktop/main/model-runtime-settings.ts";
import {
  discoverLocalModelCommands,
} from "@minke/desktop/main/local-model-command.ts";
import { createLocalModelStatusProbe } from "@minke/desktop/main/local-model-status.ts";
import {
  MinkeConfigStore,
} from "@minke/desktop/main/minke-config.ts";
import {
  DEFAULT_MODEL_RUNTIME_SETTINGS,
  MODEL_RUNTIME_SETTINGS_READ_CHANNEL,
  MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL,
  MODEL_RUNTIME_STATUS_READ_CHANNEL,
  parseModelRuntimeServiceState,
  parseModelRuntimeSettingsSnapshot,
} from "@lencx/minke-model-runtime/contract";
import {
  installLocalModel,
} from "@minke/harness-overlay/client/local-model/install.ts";
import {
  LOCAL_MODEL_SETTINGS_STYLES,
  LocalModelSettingsRuntime,
} from "@minke/harness-overlay/client/local-model/index.ts";
import {
  installLocalModelSettings,
} from "@minke/harness-overlay/client/local-model/view.tsx";
import {
  localModelEn,
  localModelZh,
} from "@minke/harness-overlay/client/local-model/locales.ts";

const roots = [];

async function temporaryRoot(prefix = "minke-local-model-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

test("local model command discovery shares standard-path and PATH lookup", async () => {
  const root = await temporaryRoot();
  const home = join(root, "home");
  const standard = join(
    home,
    ".lmstudio",
    "bin",
    process.platform === "win32" ? "lms.exe" : "lms",
  );
  await mkdir(join(home, ".lmstudio", "bin"), { recursive: true });
  await writeFile(standard, "");
  if (process.platform !== "win32") await chmod(standard, 0o700);

  assert.equal(
    await discoverLocalModelCommands({
      homeDirectory: home,
      pathValue: "",
      platform: process.platform,
      includeSystemLocations: false,
    }).then(({ lmStudio }) => lmStudio),
    standard,
  );

  await rm(standard);
  const firstBin = join(root, "first-bin");
  const secondBin = join(root, "second-bin");
  const ollamaFromPath = join(
    secondBin,
    process.platform === "win32" ? "ollama.exe" : "ollama",
  );
  await Promise.all([
    mkdir(firstBin),
    mkdir(secondBin),
  ]);
  await writeFile(ollamaFromPath, "");
  if (process.platform !== "win32") {
    await chmod(ollamaFromPath, 0o700);
  }

  assert.deepEqual(
    await discoverLocalModelCommands({
      homeDirectory: home,
      pathValue: [firstBin, secondBin].join(delimiter),
      platform: process.platform,
      includeSystemLocations: false,
    }),
    {
      ollama: ollamaFromPath,
    },
  );
  assert.deepEqual(
    await discoverLocalModelCommands({
      homeDirectory: home,
      pathValue: "",
      platform: process.platform,
      includeSystemLocations: false,
    }),
    {},
  );
});

test("model runtime settings IPC reports availability and persists opt-ins", async () => {
  const root = await temporaryRoot();
  const config = new MinkeConfigStore(root);
  const handlers = new Map();
  const applied = [];
  const ipcMain = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
  };
  const binding = bindModelRuntimeSettingsIpc(
    ipcMain,
    config.modelRuntime,
    {
      lmStudio: true,
      ollama: false,
    },
    (event) => event === "allowed",
    async (settings, mode) => {
      applied.push({ settings, mode });
    },
  );

  assert.deepEqual(
    await handlers.get(MODEL_RUNTIME_SETTINGS_READ_CHANNEL)("allowed"),
    {
      available: {
        lmStudio: true,
        ollama: false,
      },
      settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
    },
  );
  await handlers.get(MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL)(
    "allowed",
    {
      lmStudio: { enabled: true },
      ollama: { enabled: false },
    },
  );
  assert.deepEqual(await config.modelRuntime.read(), {
    lmStudio: { enabled: true },
    ollama: { enabled: false },
  });
  assert.deepEqual(applied, [
    {
      settings: {
        lmStudio: { enabled: true },
        ollama: { enabled: false },
      },
      mode: "apply",
    },
    {
      settings: {
        lmStudio: { enabled: true },
        ollama: { enabled: false },
      },
      mode: "finalize",
    },
  ]);
  await assert.rejects(
    handlers.get(MODEL_RUNTIME_SETTINGS_READ_CHANNEL)("denied"),
    /unauthorized/u,
  );
  binding.dispose();
  binding.dispose();
  assert.equal(handlers.size, 0);
});

test("settings reads wait for an in-flight live persistence transaction", async () => {
  const handlers = new Map();
  let persisted = {
    lmStudio: { enabled: false },
    ollama: { enabled: false },
  };
  let releaseWrite;
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  let announceWrite;
  const writeStarted = new Promise((resolve) => {
    announceWrite = resolve;
  });
  const binding = bindModelRuntimeSettingsIpc(
    {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    {
      async read() {
        return persisted;
      },
      async write(settings) {
        announceWrite();
        await writeGate;
        persisted = settings;
      },
    },
    {
      lmStudio: true,
      ollama: true,
    },
    () => true,
    async () => {},
  );
  const next = {
    lmStudio: { enabled: true },
    ollama: { enabled: false },
  };
  const writing = handlers.get(
    MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL,
  )("allowed", next);
  await writeStarted;

  let readSettled = false;
  const reading = handlers.get(
    MODEL_RUNTIME_SETTINGS_READ_CHANNEL,
  )("allowed").then((snapshot) => {
    readSettled = true;
    return snapshot;
  });
  await Promise.resolve();
  assert.equal(
    readSettled,
    false,
    "a new renderer generation must not hydrate from the old disk baseline",
  );

  releaseWrite();
  await writing;
  assert.deepEqual(await reading, {
    available: {
      lmStudio: true,
      ollama: true,
    },
    settings: next,
  });
  binding.dispose();
});

test("a local runtime cannot be enabled when its command is absent", async () => {
  const handlers = new Map();
  const binding = bindModelRuntimeSettingsIpc(
    {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    {
      async read() {
        return DEFAULT_MODEL_RUNTIME_SETTINGS;
      },
      async write() {
        assert.fail("unavailable settings must not be persisted");
      },
    },
    {
      lmStudio: true,
      ollama: false,
    },
    () => true,
    async () => {
      assert.fail("unavailable settings must not be applied");
    },
  );

  await assert.rejects(
    handlers.get(MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL)(
      "allowed",
      {
        lmStudio: { enabled: false },
        ollama: { enabled: true },
      },
    ),
    /Ollama command is unavailable/u,
  );
  binding.dispose();
});

test("model runtime settings stay persisted only when live reconciliation succeeds", async () => {
  const handlers = new Map();
  const writes = [];
  const initial = {
    lmStudio: { enabled: false },
    ollama: { enabled: false },
  };
  const binding = bindModelRuntimeSettingsIpc(
    {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    {
      async read() {
        return initial;
      },
      async write(settings) {
        writes.push(settings);
      },
    },
    {
      lmStudio: true,
      ollama: true,
    },
    () => true,
    async () => {
      throw new Error("candidate runtime failed");
    },
  );

  await assert.rejects(
    handlers.get(MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL)(
      "allowed",
      {
        lmStudio: { enabled: true },
        ollama: { enabled: false },
      },
    ),
    /candidate runtime failed/u,
  );
  assert.deepEqual(writes, []);
  binding.dispose();
});

test("a persistence failure restores the previous live runtime settings", async () => {
  const handlers = new Map();
  const applied = [];
  const initial = {
    lmStudio: { enabled: false },
    ollama: { enabled: false },
  };
  const binding = bindModelRuntimeSettingsIpc(
    {
      handle(channel, listener) {
        handlers.set(channel, listener);
      },
      removeHandler(channel) {
        handlers.delete(channel);
      },
    },
    {
      async read() {
        return initial;
      },
      async write() {
        throw new Error("disk unavailable");
      },
    },
    {
      lmStudio: true,
      ollama: true,
    },
    () => true,
    async (settings, mode) => {
      applied.push({ settings, mode });
    },
  );

  await assert.rejects(
    handlers.get(MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL)(
      "allowed",
      {
        lmStudio: { enabled: true },
        ollama: { enabled: false },
      },
    ),
    /disk unavailable/u,
  );
  assert.deepEqual(applied, [
    {
      settings: {
        lmStudio: { enabled: true },
        ollama: { enabled: false },
      },
      mode: "apply",
    },
    {
      settings: initial,
      mode: "rollback",
    },
  ]);
  binding.dispose();
});

test("local model settings runtime hydrates and serializes switch changes", async () => {
  const writes = [];
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    async read() {
      return {
        available: {
          lmStudio: true,
          ollama: true,
        },
        settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
      };
    },
    async write(settings) {
      writes.push({ ...settings });
    },
  });

  await runtime.initialize();
  assert.equal(runtime.getSnapshot().available.ollama, true);
  assert.equal(runtime.getSnapshot().editable, true);
  runtime.setEnabled("ollama", true);
  await runtime.flush();
  assert.deepEqual(writes, [{
    lmStudio: { enabled: false },
    ollama: { enabled: true },
  }]);
  assert.equal(
    runtime.getSnapshot().settings.ollama.enabled,
    true,
  );
  runtime.dispose();
});

test("a failed settings read stays non-editable and can retry safely", async () => {
  let reads = 0;
  const recovered = {
    lmStudio: { enabled: true },
    ollama: { enabled: false },
  };
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    async read() {
      reads += 1;
      return reads === 1
        ? {
            available: {
              lmStudio: true,
              ollama: true,
            },
            settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
            error: "read",
          }
        : {
            available: {
              lmStudio: true,
              ollama: true,
            },
            settings: recovered,
          };
    },
    async write() {
      assert.fail("an unknown persisted baseline must not be overwritten");
    },
  });

  await runtime.initialize();
  assert.equal(runtime.getSnapshot().error, "read");
  assert.equal(runtime.getSnapshot().editable, false);
  assert.throws(
    () => runtime.setEnabled("ollama", true),
    /not editable/u,
  );

  await runtime.retry();
  assert.equal(reads, 2);
  assert.equal(runtime.getSnapshot().error, undefined);
  assert.equal(runtime.getSnapshot().editable, true);
  assert.deepEqual(runtime.getSnapshot().settings, recovered);
  runtime.dispose();
});

test("local service saves isolate pending state, failures, and queued payloads", async () => {
  let rejectOllama;
  let finishLmStudio;
  const ollamaGate = new Promise((_, reject) => { rejectOllama = reject; });
  const lmStudioGate = new Promise((resolve) => { finishLmStudio = resolve; });
  const writes = [];
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    async read() {
      return {
        available: { lmStudio: true, ollama: true },
        settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
      };
    },
    async write(settings, runtimeId) {
      writes.push({ settings, runtimeId });
      await (writes.length === 1 ? ollamaGate : lmStudioGate);
    },
  });
  await runtime.initialize();
  runtime.setEnabled("ollama", true);
  const pendingOllama = runtime.flush();
  assert.equal(runtime.getSnapshot().status.ollama.applying, true);
  assert.equal(runtime.getSnapshot().status.lmStudio.applying, false);
  runtime.setEnabled("lmStudio", true);
  rejectOllama(new Error("Ollama startup failed"));
  await pendingOllama;
  const failed = runtime.getSnapshot();
  assert.equal(failed.settings.ollama.enabled, false);
  assert.equal(failed.settings.lmStudio.enabled, true);
  assert.deepEqual(failed.status.ollama, { applying: false, error: "write" });
  assert.deepEqual(failed.status.lmStudio, { applying: true, error: undefined });
  finishLmStudio();
  await runtime.flush();
  assert.deepEqual(writes, [
    { runtimeId: "ollama", settings: {
      lmStudio: { enabled: false }, ollama: { enabled: true },
    } },
    { runtimeId: "lmStudio", settings: {
      lmStudio: { enabled: true }, ollama: { enabled: false },
    } },
  ]);
  assert.equal(runtime.getSnapshot().status.ollama.error, "write");
  assert.deepEqual(runtime.getSnapshot().status.lmStudio, { applying: false, error: undefined });
  runtime.dispose();
});

test("service status is independent of auto-start and one slow status probe", async () => {
  let finishLmStudio;
  const lmStudioGate = new Promise((resolve) => { finishLmStudio = resolve; });
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    read: async () => ({
      available: { lmStudio: true, ollama: true },
      settings: { lmStudio: { enabled: true }, ollama: { enabled: false } },
    }),
    write: async () => {},
    readStatus: async (id) => id === "lmStudio" ? lmStudioGate : "running",
  });
  await runtime.initialize();
  const slow = runtime.refreshStatus("lmStudio");
  await runtime.refreshStatus("ollama");
  assert.equal(runtime.getSnapshot().services.lmStudio, "checking");
  assert.equal(runtime.getSnapshot().services.ollama, "running");
  assert.equal(runtime.getSnapshot().settings.ollama.enabled, false);
  finishLmStudio("stopped");
  await slow;
  assert.equal(runtime.getSnapshot().services.lmStudio, "stopped");
  assert.equal(runtime.getSnapshot().settings.lmStudio.enabled, true);
  runtime.dispose();
});

test("a completed switch refreshes service state and ignores a stale probe", async () => {
  let finishOldProbe;
  let requests = 0;
  const oldProbe = new Promise((resolve) => { finishOldProbe = resolve; });
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    read: async () => ({ available: { lmStudio: true, ollama: true }, settings: DEFAULT_MODEL_RUNTIME_SETTINGS }),
    write: async () => {},
    readStatus: async () => ++requests === 1 ? oldProbe : "running",
  });
  await runtime.initialize();
  const stale = runtime.refreshStatus("ollama");
  runtime.setEnabled("ollama", true);
  await runtime.flush();
  await runtime.refreshStatus("ollama");
  assert.equal(runtime.getSnapshot().services.ollama, "running");
  finishOldProbe("stopped");
  await stale;
  assert.equal(runtime.getSnapshot().services.ollama, "running");
  runtime.dispose();
});

test("a failed status check stays unknown without changing settings or save errors", async () => {
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    read: async () => ({ available: { lmStudio: true, ollama: true }, settings: DEFAULT_MODEL_RUNTIME_SETTINGS }),
    write: async () => {},
    readStatus: async () => { throw new Error("probe timeout"); },
  });
  await runtime.initialize();
  await runtime.refreshStatus("ollama");
  assert.equal(runtime.getSnapshot().services.ollama, "unknown");
  assert.deepEqual(runtime.getSnapshot().settings, DEFAULT_MODEL_RUNTIME_SETTINGS);
  assert.equal(runtime.getSnapshot().status.ollama.error, undefined);
  runtime.dispose();
});

test("targeted settings IPC preserves the other service even when its command is unavailable", async () => {
  const handlers = new Map();
  let persisted = { lmStudio: { enabled: true }, ollama: { enabled: false } };
  const applied = [];
  const binding = bindModelRuntimeSettingsIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
  }, {
    read: async () => persisted,
    write: async (settings) => { persisted = settings; },
  }, { lmStudio: false, ollama: true }, () => true, async (settings, mode, runtimeId) => {
    applied.push({ settings, mode, runtimeId });
  });
  await handlers.get(MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL)(null, {
    lmStudio: { enabled: false }, ollama: { enabled: true },
  }, "ollama");
  assert.deepEqual(persisted, { lmStudio: { enabled: true }, ollama: { enabled: true } });
  assert.deepEqual(applied, [
    { settings: persisted, mode: "apply", runtimeId: "ollama" },
    { settings: persisted, mode: "finalize", runtimeId: "ollama" },
  ]);
  await assert.rejects(handlers.get(MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL)(
    null, persisted, "unknown-service",
  ), /runtime/u);
  binding.dispose();
});

test("local model status commands use the resolved shell PATH without Node bootstrap flags", {
  skip: process.platform === "win32",
}, async () => {
  const root = await temporaryRoot("minke-status-environment-");
  const command = join(root, "lms");
  const helper = join(root, "minke-fixture-status-helper");
  await writeFile(command, '#!/bin/sh\n[ -z "$NODE_OPTIONS$ELECTRON_RUN_AS_NODE" ] || exit 7\nexec minke-fixture-status-helper\n');
  await writeFile(helper, '#!/bin/sh\nprintf \'{"running":true}\\n\'\n');
  await Promise.all([chmod(command, 0o700), chmod(helper, 0o700)]);
  const probe = environment => createLocalModelStatusProbe({ lmStudio: command }, { environment });
  assert.equal(await probe({ PATH: "/usr/bin:/bin" })("lmStudio"), "unknown");
  assert.equal(await probe({ PATH: root, NODE_OPTIONS: "--invalid", ELECTRON_RUN_AS_NODE: "1" })("lmStudio"), "running");
});

test("local service status probes use read-only CLI and HTTP health checks", async () => {
  const calls = [];
  const probe = createLocalModelStatusProbe({ lmStudio: "/installed/lms" }, {
    run: async (command, args) => {
      calls.push({ command, args });
      return JSON.stringify({ running: true, port: 51102 });
    },
    fetch: async (url, options) => {
      assert.equal(url, "http://127.0.0.1:11434/api/version");
      assert.equal(options.redirect, "error");
      assert.equal(options.signal.aborted, false);
      return Response.json({ version: "0.30.6" });
    },
  });
  assert.equal(await probe("lmStudio"), "running");
  assert.equal(await probe("ollama"), "running");
  assert.deepEqual(calls, [{ command: "/installed/lms", args: ["server", "status", "--json"] }]);
});

test("service probes distinguish stopped services from unavailable diagnostics", async () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error(), { code: "ECONNREFUSED" }) });
  const stopped = createLocalModelStatusProbe({ lmStudio: "/installed/lms" }, {
    run: async () => JSON.stringify({ running: false }),
    fetch: async () => { throw refused; },
  });
  assert.equal(await stopped("lmStudio"), "stopped");
  assert.equal(await stopped("ollama"), "stopped");
  const unknown = createLocalModelStatusProbe({ lmStudio: "/installed/lms" }, {
    run: async () => { throw new Error("permission denied"); },
    fetch: async () => { throw new DOMException("timeout", "TimeoutError"); },
  });
  assert.equal(await unknown("lmStudio"), "unknown");
  assert.equal(await unknown("ollama"), "unknown");
  const invalid = createLocalModelStatusProbe({}, { fetch: async () => Response.json({ error: "not a service" }) });
  assert.equal(await invalid("ollama"), "unknown");
  const external = createLocalModelStatusProbe({}, {
    fetch: async (url) => {
      assert.equal(url, "http://127.0.0.1:1234/v1/models");
      return Response.json({ object: "list", data: [] });
    },
  });
  assert.equal(await external("lmStudio"), "running", "an external empty service can be running without an installed CLI");
});

test("service status IPC authorizes and validates each read without touching preferences", async () => {
  const handlers = new Map();
  const calls = [];
  const binding = bindModelRuntimeSettingsIpc({
    handle: (channel, listener) => handlers.set(channel, listener),
    removeHandler: (channel) => handlers.delete(channel),
  }, {
    read: async () => assert.fail("status reads must not wait on settings persistence"),
    write: async () => assert.fail("status reads must not persist anything"),
  }, { lmStudio: true, ollama: true }, event => event === "allowed",
  async () => assert.fail("status reads must never start a service"),
  async id => { calls.push(id); return id === "lmStudio" ? "stopped" : "running"; });
  const read = handlers.get(MODEL_RUNTIME_STATUS_READ_CHANNEL);
  assert.equal(await read("allowed", "ollama"), "running");
  assert.equal(await read("allowed", "lmStudio"), "stopped");
  await assert.rejects(read("denied", "ollama"), /unauthorized/u);
  await assert.rejects(read("allowed", "unknown-service"), /runtime id/u);
  assert.deepEqual(calls, ["ollama", "lmStudio"]);
  for (const value of [true, "starting", {}, null]) {
    assert.throws(() => parseModelRuntimeServiceState(value), /service state/u);
  }
  binding.dispose();
  assert.equal(handlers.size, 0);
});

test("a rejected live switch rolls the optimistic setting back", async () => {
  const runtime = new LocalModelSettingsRuntime({
    available: true,
    async read() {
      return {
        available: {
          lmStudio: true,
          ollama: true,
        },
        settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
      };
    },
    async write() {
      throw new Error("live apply failed");
    },
  });

  await runtime.initialize();
  runtime.setEnabled("lmStudio", true);
  assert.equal(
    runtime.getSnapshot().settings.lmStudio.enabled,
    true,
  );
  await runtime.flush();
  assert.equal(runtime.getSnapshot().status.lmStudio.error, "write");
  assert.equal(
    runtime.getSnapshot().settings.lmStudio.enabled,
    false,
  );
  runtime.dispose();
});

function localModelViewRuntime(overrides = {}) {
  const snapshot = {
    available: {
      lmStudio: true,
      ollama: false,
    },
    settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
    editable: true,
    services: { lmStudio: "unknown", ollama: "unknown" },
    status: {
      lmStudio: { applying: false, error: undefined },
      ollama: { applying: false, error: undefined },
    },
    error: undefined,
    revision: 1,
    ...overrides.snapshot,
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    retry: async () => {},
    refreshStatus: async () => {},
    setEnabled() {},
    ...overrides,
  };
}

function installLocalModelSlotHarness(runtime) {
  const records = [];
  const events = [];
  const slots = {
    inject(name, callback) {
      events.push(`inject:${name}`);
      const unregister = callback();
      return () => {
        unregister();
        events.push(`inject:remove:${name}`);
      };
    },
    register(options, component) {
      records.push({ options, component });
      events.push(`register:${options.name}`);
      return () => events.push(`register:remove:${options.name}`);
    },
  };
  const dispose = installLocalModelSettings(
    slots,
    runtime,
    (key) => localModelEn[key],
  );
  return { dispose, events, records };
}

test("native Models keeps both local services in one section", () => {
  const runtime = localModelViewRuntime();
  const harness = installLocalModelSlotHarness(runtime);
  assert.deepEqual(harness.records.map(({ options }) => options.name), [
    "settings.models.footer",
  ]);
  const services = harness.records[0];
  const markup = renderToStaticMarkup(createElement(
    services.component,
    services.options.inject(),
  ));
  assert.match(markup, /aria-labelledby="minke-local-model-services-title"/u);
  assert.match(markup, /Local services/u);
  assert.match(markup, /data-minke-local-model-footer-row="lmStudio"/u);
  assert.match(markup, /data-minke-local-model-footer-row="ollama"/u);
  assert.equal((markup.match(/role="switch"/gu) ?? []).length, 2);
  assert.match(markup, /aria-label="LM Studio: Auto-start"/u);
  assert.match(markup, /aria-label="Ollama: Auto-start"/u);
  assert.match(markup, /Available on this device/u);
  assert.match(markup, /Local command not found; configure a service URL manually/u);
  assert.doesNotMatch(markup, /No models detected/u,
    "command availability does not claim to know the provider's model catalog");
  assert.doesNotMatch(LOCAL_MODEL_SETTINGS_STYLES, /data-minke-local-model-provider-card/u,
    "provider discovery must not hide either local service control");
  harness.dispose();
  harness.dispose();
  assert.deepEqual(harness.events.slice(-2), [
    "register:remove:settings.models.footer",
    "inject:remove:settings.models.footer",
  ]);
});

test("local service switches render independent busy and error states", () => {
  for (const phase of ["pending", "failed"]) {
    const runtime = localModelViewRuntime({ snapshot: {
      available: { lmStudio: true, ollama: true },
      status: {
        lmStudio: { applying: false, error: undefined },
        ollama: { applying: phase === "pending", error: phase === "failed" ? "write" : undefined },
      },
    } });
    const harness = installLocalModelSlotHarness(runtime);
    const services = harness.records[0];
    const dom = new JSDOM(renderToStaticMarkup(createElement(services.component, services.options.inject())));
    try {
      const lmStudio = dom.window.document.querySelector('[data-minke-local-model-settings="lmStudio"]');
      const ollama = dom.window.document.querySelector('[data-minke-local-model-settings="ollama"]');
      assert.equal(lmStudio.querySelector('[role="switch"]').disabled, false);
      assert.equal(lmStudio.getAttribute('aria-busy'), "false");
      assert.equal(lmStudio.hasAttribute('data-error'), false);
      assert.doesNotMatch(lmStudio.textContent, /Could not apply|Applying/u);
      assert.equal(ollama.querySelector('[role="switch"]').disabled, phase === "pending");
      assert.equal(ollama.hasAttribute('data-error'), phase === "failed");
      assert.match(ollama.textContent, phase === "failed" ? /Could not apply/u : /Applying/u);
    } finally {
      dom.window.close();
      harness.dispose();
    }
  }
});

test("service state tags sit beside each name independently of the auto-start switch", () => {
  const runtime = localModelViewRuntime({ snapshot: {
    services: { lmStudio: "stopped", ollama: "running" },
    settings: { lmStudio: { enabled: true }, ollama: { enabled: false } },
  } });
  const harness = installLocalModelSlotHarness(runtime);
  const services = harness.records[0];
  const dom = new JSDOM(renderToStaticMarkup(createElement(services.component, services.options.inject())));
  try {
    const tags = [...dom.window.document.querySelectorAll('.minke-local-model-row__heading [role="status"]')];
    assert.deepEqual(tags.map(tag => tag.textContent), ["Not running", "Running"]);
    assert.deepEqual(tags.map(tag => tag.getAttribute("aria-label")), ["LM Studio: Not running", "Ollama: Running"]);
    assert.deepEqual([...dom.window.document.querySelectorAll('[role="switch"]')].map(input => input.getAttribute('aria-checked') === 'true'), [true, false]);
  } finally {
    dom.window.close();
    harness.dispose();
  }
});

test("service status refreshes only while its settings view is visible and mounted", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  let visible = true;
  Object.defineProperty(dom.window.document, "visibilityState", { get: () => visible ? "visible" : "hidden" });
  let tick;
  let cleared = false;
  dom.window.setInterval = (callback, delay) => {
    assert.equal(delay, 5_000);
    tick = callback;
    return 7;
  };
  dom.window.clearInterval = (id) => { assert.equal(id, 7); cleared = true; };
  let reads = 0;
  const runtime = localModelViewRuntime({ refreshStatus: async () => { reads++; } });
  const harness = installLocalModelSlotHarness(runtime);
  const services = harness.records[0];
  try {
    await withBrowserGlobals(dom, async () => {
      const { createRoot } = await import("react-dom/client");
      const root = createRoot(dom.window.document.getElementById("root"));
      await act(async () => root.render(createElement(services.component, services.options.inject())));
      assert.equal(reads, 1);
      tick();
      assert.equal(reads, 2);
      visible = false;
      tick();
      assert.equal(reads, 2);
      visible = true;
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
      assert.equal(reads, 3);
      await act(async () => root.unmount());
      assert.equal(cleared, true);
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      dom.window.document.dispatchEvent(new dom.window.Event("visibilitychange"));
      assert.equal(reads, 3);
    });
  } finally {
    harness.dispose();
    dom.window.close();
  }
});

async function withBrowserGlobals(dom, callback) {
  const values = {
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: dom.window.navigator,
    Node: dom.window.Node,
    window: dom.window,
  };
  const descriptors = new Map(
    Object.keys(values).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        value,
        writable: true,
      });
    }
    return await callback();
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  }
}

test("local service auto-start switches delegate through the settings runtime", async () => {
  const changes = [];
  const runtime = localModelViewRuntime({
    setEnabled(id, enabled) {
      changes.push({ id, enabled });
    },
  });
  const harness = installLocalModelSlotHarness(runtime);
  const services = harness.records[0];
  const dom = new JSDOM(
    '<!doctype html><div id="root"></div>',
    { pretendToBeVisual: true },
  );
  try {
    await withBrowserGlobals(dom, async () => {
      const { createRoot } = await import("react-dom/client");
      const container =
        dom.window.document.getElementById("root");
      assert.ok(container);
      const root = createRoot(container);
      try {
        await act(async () => {
          root.render(
            createElement(services.component, services.options.inject()),
          );
        });
        const input = container.querySelector(
          '[role="switch"][aria-label="LM Studio: Auto-start"]',
        );
        assert.ok(input instanceof dom.window.HTMLButtonElement);
        assert.equal(input.disabled, false);
        await act(async () => {
          input.click();
        });
        assert.deepEqual(changes, [{
          id: "lmStudio",
          enabled: true,
        }]);
      } finally {
        await act(async () => {
          root.unmount();
        });
      }
    });
  } finally {
    dom.window.close();
    harness.dispose();
  }
});

test("local model installation targets the native Models footer", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const cleanups = [];
  const slotNames = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      minkeDesktop: {
        modelRuntime: {
          async read() {
            return {
              available: {
                lmStudio: true,
                ollama: true,
              },
              settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
            };
          },
          async write() {},
        },
      },
    },
  });

  try {
    const ctx = {
      effect(callback, label) {
        if (label.endsWith(" styles")) return;
        const cleanup = callback();
        if (typeof cleanup === "function") cleanups.push(cleanup);
      },
      locale: {
        register() {
          return () => {};
        },
        bind() {
          return (key) => localModelEn[key];
        },
      },
      slots: {
        inject(name, callback) {
          slotNames.push(name);
          const cleanup = callback();
          return typeof cleanup === "function"
            ? cleanup
            : () => {};
        },
        register() {
          return () => {};
        },
      },
    };

    installLocalModel(ctx);
    await Promise.resolve();
    assert.deepEqual(slotNames, ["settings.models.footer"]);
    assert.equal(slotNames.includes("settings.section"), false);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
    if (originalWindow === undefined) {
      delete globalThis.window;
    } else {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    }
  }
});

test("model runtime settings snapshots and bilingual copy stay exact", () => {
  assert.deepEqual(
    parseModelRuntimeSettingsSnapshot({
      available: {
        lmStudio: false,
        ollama: true,
      },
      settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
    }),
    {
      available: {
        lmStudio: false,
        ollama: true,
      },
      settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
    },
  );
  assert.throws(
    () => parseModelRuntimeSettingsSnapshot({
      available: {
        lmStudio: true,
        ollama: true,
      },
      settings: DEFAULT_MODEL_RUNTIME_SETTINGS,
      unknown: true,
    }),
    /model runtime settings snapshot/u,
  );
  assert.deepEqual(
    Object.keys(localModelEn).sort(),
    Object.keys(localModelZh).sort(),
  );
  assert.equal(localModelZh.autoStart, "自动启动");
  assert.equal(localModelEn.autoStart, "Auto-start");
  assert.equal(localModelZh.restartRequired, "立即生效");
  assert.equal(localModelEn.restartRequired, "Applies immediately");
});
