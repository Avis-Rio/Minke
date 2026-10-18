import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  harnessHostArguments,
  readHarnessRuntimeLayout,
} from "@minke/desktop/main/harness-launch.ts";
import {
  HarnessRuntime,
  harnessRuntimeEnvironment,
  parseHarnessRuntimeEndpoint,
} from "@minke/desktop/main/harness-runtime.ts";
import {
  bindModelRuntimeSettingsIpc,
} from "@minke/desktop/main/model-runtime-settings.ts";
import {
  AGENT_BROWSER_IPC_VERSION_ENV,
  AGENT_BROWSER_PROTOCOL_VERSION,
} from "@minke/harness-overlay/agent-browser-contract.ts";
import {
  MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV,
} from "@minke/harness-overlay/web-search-settings-contract.ts";
import {
  agentTurnErrorResponse,
  agentTurnResultResponse,
  parseAgentTurnProcessRequest,
} from "@minke/harness-overlay/agent-turn-contract.ts";
import {
  HarnessLifecycle,
} from "@minke/desktop/main/harness-lifecycle.ts";
import {
  resolveHarnessTimeout,
} from "@minke/desktop/main/harness-timeout.ts";
import {
  DEFAULT_MODEL_RUNTIME_CONTROL_TIMEOUT_MS,
  HarnessControlChannel,
  LM_STUDIO_COLD_START_BUDGET_MS,
  MODEL_RUNTIME_RECONFIGURE_BUDGET,
  OLLAMA_COLD_START_BUDGET_MS,
} from "@minke/desktop/main/harness-control.ts";
import {
  replacedTrustedHostsResponse,
} from "@minke/harness-overlay/trusted-host-control-contract.ts";
import {
  createReconfigureModelRuntimesRequest,
  MODEL_RUNTIME_SETTINGS_WRITE_CHANNEL,
  modelRuntimesReconfiguredResponse,
  parseModelRuntimeControlResponse,
  parseReconfigureModelRuntimesRequest,
} from "@lencx/minke-model-runtime/contract";

const HARNESS_ORIGIN = "http://127.0.0.1:43117";
const HARNESS_LAUNCH_TOKEN = "a".repeat(43);
const HARNESS_AUTHENTICATED_URL =
  `${HARNESS_ORIGIN}/?token=${HARNESS_LAUNCH_TOKEN}`;

function harnessEndpoint() {
  return {
    origin: HARNESS_ORIGIN,
    authenticatedUrl: HARNESS_AUTHENTICATED_URL,
    launchToken: HARNESS_LAUNCH_TOKEN,
  };
}

function hasEnvironmentName(environment, name) {
  const normalized = name.toUpperCase();
  return Object.keys(environment).some(
    (key) => key.toUpperCase() === normalized,
  );
}

async function withRuntime(metadata, callback) {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "minke-harness-launch-"));
  try {
    await writeFile(
      join(runtimeRoot, "dsh-runtime.json"),
      `${JSON.stringify(metadata)}\n`,
    );
    await callback(runtimeRoot);
  } finally {
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

test("desktop and smoke launch Harness through one staged layout contract", async () => {
  await withRuntime(
    {
      schemaVersion: 3,
      productBundle: {
        packageName: "@lencx/minke-harness-overlay",
        patch: "cordis.patch.yml",
      },
    },
    async (runtimeRoot) => {
      const layout = await readHarnessRuntimeLayout(runtimeRoot);
      assert.deepEqual(layout, {
        entryPath: join(runtimeRoot, "index.mjs"),
        pnpmEntry: join(
          runtimeRoot,
          "node_modules",
          "pnpm",
          "bin",
          "pnpm.cjs",
        ),
        productPackageName: "@lencx/minke-harness-overlay",
        productPatch: join(
          runtimeRoot,
          "node_modules",
          "@lencx",
          "minke-harness-overlay",
          "cordis.patch.yml",
        ),
        runtimeBin: join(runtimeRoot, "bin"),
      });
      assert.deepEqual(harnessHostArguments(layout), [
        "--expose-internals",
        join(runtimeRoot, "index.mjs"),
        "--minke-desktop-host",
        layout.productPatch,
        layout.pnpmEntry,
      ]);
    },
  );
});

test("stopping while the launch layout is loading cannot start a late Host process", async () => {
  await withRuntime({ schemaVersion: 3, productBundle: {
    packageName: "@lencx/minke-harness-overlay", patch: "cordis.patch.yml",
  } }, async runtimeRoot => {
    const runtime = new HarnessRuntime({
      runtimeRoot, dshHome: join(runtimeRoot, "home"), electronExecutable: process.execPath,
      modelRuntimes: { lmStudio: { enabled: false }, ollama: { enabled: false } },
      pluginManagement: { safeMode: false, disabledPlugins: [] },
      onUnexpectedExit: () => { throw new Error("must not spawn after stop"); },
    });
    const started = runtime.start();
    const concurrent = assert.rejects(runtime.start(), /already running/u);
    await runtime.stop();
    await assert.rejects(started, /stopped during startup/u);
    await concurrent;
  });
});

test("the staged layout contract rejects unsafe product metadata", async () => {
  await withRuntime(
    {
      schemaVersion: 3,
      productBundle: {
        packageName: "@lencx/minke-harness-overlay",
        patch: "../outside.yml",
      },
    },
    async (runtimeRoot) => {
      await assert.rejects(
        readHarnessRuntimeLayout(runtimeRoot),
        /invalid product bundle metadata/u,
      );
    },
  );
});

test("the staged layout contract rejects stale runtime metadata", async () => {
  await withRuntime(
    {
      schemaVersion: 2,
      productBundle: {
        packageName: "@lencx/minke-harness-overlay",
        patch: "cordis.patch.yml",
      },
    },
    async (runtimeRoot) => {
      await assert.rejects(
        readHarnessRuntimeLayout(runtimeRoot),
        /invalid product bundle metadata/u,
      );
    },
  );
});

test("Harness readiness requires the exact alpha.2 authenticated loopback URL", () => {
  assert.deepEqual(
    parseHarnessRuntimeEndpoint(HARNESS_AUTHENTICATED_URL),
    harnessEndpoint(),
  );

  for (const candidate of [
    HARNESS_ORIGIN,
    `${HARNESS_ORIGIN}/?token=short`,
    `${HARNESS_AUTHENTICATED_URL}&debug=1`,
    `${HARNESS_AUTHENTICATED_URL}#fragment`,
    `${HARNESS_ORIGIN}/session?token=${HARNESS_LAUNCH_TOKEN}`,
    `${HARNESS_ORIGIN}/?token=${HARNESS_LAUNCH_TOKEN}&token=${HARNESS_LAUNCH_TOKEN}`,
    `http://localhost:43117/?token=${HARNESS_LAUNCH_TOKEN}`,
    `https://127.0.0.1:43117/?token=${HARNESS_LAUNCH_TOKEN}`,
    `http://user@127.0.0.1:43117/?token=${HARNESS_LAUNCH_TOKEN}`,
  ]) {
    assert.throws(
      () => parseHarnessRuntimeEndpoint(candidate),
      (error) =>
        error instanceof Error &&
        error.message ===
          "Harness published an invalid authenticated readiness URL" &&
        !error.message.includes(HARNESS_LAUNCH_TOKEN),
      candidate,
    );
  }
});

test("the desktop runtime passes both explicit local-model opt-ins", () => {
  const layout = {
    pnpmEntry: "/runtime/node_modules/pnpm/bin/pnpm.cjs",
    runtimeBin: "/runtime/bin",
  };
  const options = {
    dshHome: "/data/harness",
    electronExecutable: "/app/electron",
    modelRuntimes: {
      lmStudio: {
        enabled: false,
        command: "/home/user/.lmstudio/bin/lms",
      },
      ollama: {
        enabled: true,
        command: "/usr/local/bin/ollama",
      },
    },
    pluginManagement: {
      safeMode: true,
      disabledPlugins: ["broken-plugin"],
    },
    webSearch: {
      fallbackEnabled: false,
    },
  };
  const inherited = {
    Path: "/usr/bin",
    dsh_home: "/stale/dsh",
    electron_run_as_node: "ambient",
    node_options: "--require /tmp/ambient.cjs",
    Node_Path: "/tmp/ambient-modules",
    minke_node_executable: "/stale/electron",
    minke_pnpm_entry: "/stale/pnpm.cjs",
    dsh_electron_executable: "/legacy/electron",
    dsh_pnpm_entry: "/legacy/pnpm.cjs",
    MINKE_LM_STUDIO_ENABLED: "1",
    MINKE_LM_STUDIO_COMMAND: "/stale/lms",
    minke_lm_studio_command: "/stale/lowercase-lms",
    MINKE_OLLAMA_ENABLED: "0",
    MINKE_OLLAMA_COMMAND: "/stale/ollama",
    minke_ollama_command: "/stale/lowercase-ollama",
    MINKE_PLUGIN_SAFE_MODE: "0",
    MINKE_DISABLED_PLUGINS: "[\"stale-plugin\"]",
    [MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV]: "1",
    [MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV.toLowerCase()]:
      "stale-lowercase",
    [AGENT_BROWSER_IPC_VERSION_ENV]: "stale",
    [AGENT_BROWSER_IPC_VERSION_ENV.toLowerCase()]:
      "stale-lowercase",
    minke_host_root: "/stale/root",
    PRESERVED: "yes",
  };

  assert.deepEqual(
    harnessRuntimeEnvironment(layout, options, inherited),
    {
      PATH: ["/runtime/bin", "/usr/bin"].join(process.platform === "win32" ? ";" : ":"),
      MINKE_LM_STUDIO_ENABLED: "0",
      MINKE_LM_STUDIO_COMMAND: "/home/user/.lmstudio/bin/lms",
      MINKE_OLLAMA_ENABLED: "1",
      MINKE_OLLAMA_COMMAND: "/usr/local/bin/ollama",
      MINKE_PLUGIN_SAFE_MODE: "1",
      [MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV]: "0",
      PRESERVED: "yes",
      DSH_HOME: "/data/harness",
      ELECTRON_RUN_AS_NODE: "1",
      MINKE_INTERACTIVE_NODE_OPTIONS:
        "--require /tmp/ambient.cjs",
      MINKE_INTERACTIVE_NODE_PATH: "/tmp/ambient-modules",
      MINKE_NODE_BOOTSTRAP:
        join(layout.runtimeBin, "node-environment-bootstrap.cjs"),
      MINKE_NODE_EXECUTABLE: "/app/electron",
      MINKE_PNPM_ENTRY: "/runtime/node_modules/pnpm/bin/pnpm.cjs",
    },
  );
  assert.equal(
    harnessRuntimeEnvironment(
      layout,
      {
        ...options,
        webSearch: {
          fallbackEnabled: true,
        },
      },
      inherited,
    )[MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV],
    "1",
  );
  const { webSearch: _webSearch, ...optionsWithoutWebSearch } =
    options;
  assert.equal(
    harnessRuntimeEnvironment(
      layout,
      optionsWithoutWebSearch,
      inherited,
    )[MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV],
    "1",
  );
  assert.equal(
    harnessRuntimeEnvironment(
      layout,
      {
        ...options,
        agentBrowser: {},
      },
      inherited,
    )[AGENT_BROWSER_IPC_VERSION_ENV],
    String(AGENT_BROWSER_PROTOCOL_VERSION),
  );
  assert.equal(
    hasEnvironmentName(harnessRuntimeEnvironment(
      layout,
      options,
      inherited,
    ), AGENT_BROWSER_IPC_VERSION_ENV),
    false,
  );
  assert.equal(
    hasEnvironmentName(
      harnessRuntimeEnvironment(layout, options, inherited),
      "MINKE_HOST_ROOT",
    ),
    false,
  );
  assert.equal(
    harnessRuntimeEnvironment(
      layout,
      {
        ...options,
        modelRuntimes: {
          ...options.modelRuntimes,
          lmStudio: {
            ...options.modelRuntimes.lmStudio,
            enabled: true,
          },
        },
      },
      inherited,
    ).MINKE_LM_STUDIO_ENABLED,
    "1",
  );
  assert.equal(
    hasEnvironmentName(
      harnessRuntimeEnvironment(
        layout,
        {
          ...options,
          modelRuntimes: {
            ...options.modelRuntimes,
            lmStudio: {
              enabled: false,
              command: undefined,
            },
          },
        },
        inherited,
      ),
      "MINKE_LM_STUDIO_COMMAND",
    ),
    false,
  );
  assert.equal(
    hasEnvironmentName(
      harnessRuntimeEnvironment(
        layout,
        {
          ...options,
          modelRuntimes: {
            ...options.modelRuntimes,
            ollama: {
              enabled: false,
              command: undefined,
            },
          },
        },
        inherited,
      ),
      "MINKE_OLLAMA_COMMAND",
    ),
    false,
  );
});

test("Harness control waits for an acknowledged trusted-host replacement", async () => {
  const child = new EventEmitter();
  child.connected = true;
  const requests = [];
  child.send = (message, callback) => {
    requests.push(message);
    callback?.(null);
    queueMicrotask(() => {
      child.emit(
        "message",
        replacedTrustedHostsResponse(message.requestId),
      );
    });
    return true;
  };
  const control = new HarnessControlChannel(child, 50, 50);

  assert.throws(
    () =>
      control.replaceTrustedHosts([
        "minke.example-tailnet.ts.net/path",
      ]),
    /invalid Harness trusted-host authority/u,
  );
  await control.replaceTrustedHosts([
    "minke.example-tailnet.ts.net",
  ]);

  assert.deepEqual(requests, [{
    channel: "minke:harness-control",
    protocolVersion: 1,
    requestId: 1,
    type: "trusted-hosts/replace",
    trustedHosts: ["minke.example-tailnet.ts.net"],
  }]);
  control.dispose();
});

test("Harness control waits for live model-runtime reconciliation", async () => {
  const child = new EventEmitter();
  child.connected = true;
  const requests = [];
  child.send = (message, callback) => {
    requests.push(message);
    callback?.(null);
    queueMicrotask(() => {
      child.emit(
        "message",
        modelRuntimesReconfiguredResponse(message.requestId),
      );
    });
    return true;
  };
  const control = new HarnessControlChannel(child, 50, 50);

  await control.reconfigureModelRuntimes({
    lmStudio: { enabled: true },
    ollama: { enabled: false },
  });

  assert.deepEqual(requests, [{
    channel: "minke:model-runtime-control",
    protocolVersion: 1,
    requestId: 1,
    type: "model-runtimes/reconfigure",
    mode: "apply",
    settings: {
      lmStudio: { enabled: true },
      ollama: { enabled: false },
    },
  }]);
  await control.reconfigureModelRuntimes({
    lmStudio: { enabled: true }, ollama: { enabled: true },
  }, "apply", "ollama");
  assert.equal(parseReconfigureModelRuntimesRequest(requests.at(-1)).runtimeId, "ollama");
  control.dispose();
});

test("Harness control runs and cancels Agent turns over private IPC", async () => {
  const child = new EventEmitter();
  child.connected = true;
  const requests = [];
  child.send = (message, callback) => {
    requests.push(message);
    callback?.(null);
    if (message.type === "agent-turn/run") {
      queueMicrotask(() => {
        child.emit(
          "message",
          agentTurnResultResponse(message.requestId, {
            outcome: "completed",
            sessionId: "session-im-account-1-peer-2",
            text: "hello from Harness",
            turn: 0,
            endReason: "completed",
          }),
        );
      });
    }
    return true;
  };
  const control = new HarnessControlChannel(child, 50, 50, 50);

  assert.deepEqual(
    await control.runAgentTurn({
      operationId: "weixin:account-1:message-7",
      sessionId: "session-im-account-1-peer-2",
      text: "hello",
    }),
    {
      outcome: "completed",
      sessionId: "session-im-account-1-peer-2",
      text: "hello from Harness",
      turn: 0,
      endReason: "completed",
    },
  );
  assert.deepEqual(
    parseAgentTurnProcessRequest(requests[0]),
    requests[0],
  );
  assert.deepEqual(requests[0], {
    channel: "minke:agent-turn:process",
    protocolVersion: 1,
    requestId: 1,
    type: "agent-turn/run",
    input: {
      operationId: "weixin:account-1:message-7",
      sessionId: "session-im-account-1-peer-2",
      text: "hello",
    },
  });

  const abortingChild = new EventEmitter();
  abortingChild.connected = true;
  const abortRequests = [];
  abortingChild.send = (message, callback) => {
    abortRequests.push(message);
    callback?.(null);
    return true;
  };
  const abortingControl =
    new HarnessControlChannel(abortingChild, 50, 50, 50);
  const abort = new AbortController();
  const pending = abortingControl.runAgentTurn({
    operationId: "telegram:account-1:update-9",
    sessionId: "session-im-account-1-peer-9",
    text: "stop",
  }, { signal: abort.signal });
  abort.abort(new Error("caller stopped"));
  await assert.rejects(pending, {
    name: "AbortError",
    message: "caller stopped",
  });
  assert.equal(abortRequests[1]?.type, "agent-turn/cancel");
  assert.equal(abortRequests[1]?.requestId, 1);

  control.dispose();
  abortingControl.dispose();
});

test("Harness Agent turn IPC rejects on timeout and child exit", async () => {
  const timeoutChild = new EventEmitter();
  timeoutChild.connected = true;
  const timeoutRequests = [];
  timeoutChild.send = (message, callback) => {
    timeoutRequests.push(message);
    callback?.(null);
    return true;
  };
  const timeoutControl =
    new HarnessControlChannel(timeoutChild, 50, 50, 10);
  await assert.rejects(
    timeoutControl.runAgentTurn({
      operationId: "discord:account-1:event-1",
      sessionId: "session-im-account-1-peer-1",
      text: "wait",
    }),
    /Agent turn within 10 ms/u,
  );
  assert.equal(timeoutRequests[1]?.type, "agent-turn/cancel");

  const exitChild = new EventEmitter();
  exitChild.connected = true;
  exitChild.send = (_message, callback) => {
    callback?.(null);
    return true;
  };
  const exitControl =
    new HarnessControlChannel(exitChild, 50, 50, 1_000);
  const pending = exitControl.runAgentTurn({
    operationId: "weixin:account-1:message-8",
    sessionId: "session-im-account-1-peer-2",
    text: "hello",
  });
  exitChild.emit("exit", 17, null);
  await assert.rejects(
    pending,
    /Harness control channel closed/u,
  );

  timeoutControl.dispose();
  exitControl.dispose();
});

test("Harness control rejects Agent turn control-plane failures", async () => {
  const child = new EventEmitter();
  child.connected = true;
  child.send = (message, callback) => {
    callback?.(null);
    if (message.type === "agent-turn/run") {
      queueMicrotask(() => {
        child.emit(
          "message",
          agentTurnErrorResponse(
            message.requestId,
            "control-rpc-error",
            "session.history failed: store busy",
          ),
        );
      });
    }
    return true;
  };
  const control = new HarnessControlChannel(
    child,
    50,
    50,
    50,
  );

  await assert.rejects(
    control.runAgentTurn({
      operationId: "weixin:account-1:message-12",
      sessionId: "session-im-account-1-peer-2",
      text: "retry me",
    }),
    /control-rpc-error: session\.history failed: store busy/u,
  );
  control.dispose();
});

test("the model-runtime ACK deadline covers the bounded cold-start path", () => {
  assert.equal(LM_STUDIO_COLD_START_BUDGET_MS, 93_250);
  assert.equal(OLLAMA_COLD_START_BUDGET_MS, 15_250);
  assert.ok(LM_STUDIO_COLD_START_BUDGET_MS > 90_000);
  assert.equal(
    DEFAULT_MODEL_RUNTIME_CONTROL_TIMEOUT_MS,
    LM_STUDIO_COLD_START_BUDGET_MS +
      OLLAMA_COLD_START_BUDGET_MS +
      MODEL_RUNTIME_RECONFIGURE_BUDGET
        .controlDeliveryMarginMs,
  );
  assert.ok(
    DEFAULT_MODEL_RUNTIME_CONTROL_TIMEOUT_MS >
      LM_STUDIO_COLD_START_BUDGET_MS,
  );
});

test("crash recovery keeps the persisted model settings when persistence and live rollback both fail", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "minke-model-runtime-transaction-"),
  );
  const runtimeRoot = join(root, "runtime");
  const dshHome = join(root, "data");
  const launchesPath = join(dshHome, "launches.txt");
  const handlers = new Map();
  let resolveCrash;
  const crashed = new Promise((resolve) => {
    resolveCrash = resolve;
  });
  let runtime;
  let binding;
  try {
    await Promise.all([
      mkdir(join(runtimeRoot, "bin"), { recursive: true }),
      mkdir(
        join(runtimeRoot, "node_modules", "pnpm", "bin"),
        { recursive: true },
      ),
      mkdir(
        join(
          runtimeRoot,
          "node_modules",
          "@lencx",
          "minke-harness-overlay",
        ),
        { recursive: true },
      ),
      mkdir(dshHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(runtimeRoot, "dsh-runtime.json"),
        `${JSON.stringify({
          schemaVersion: 3,
          productBundle: {
            packageName: "@lencx/minke-harness-overlay",
            patch: "cordis.patch.yml",
          },
        })}\n`,
      ),
      writeFile(
        join(runtimeRoot, "node_modules", "pnpm", "bin", "pnpm.cjs"),
        "",
      ),
      writeFile(
        join(
          runtimeRoot,
          "node_modules",
          "@lencx",
          "minke-harness-overlay",
          "cordis.patch.yml",
        ),
        "",
      ),
      writeFile(
        join(runtimeRoot, "index.mjs"),
        [
          'import { appendFile } from "node:fs/promises";',
          'import { join } from "node:path";',
          "await appendFile(",
          '  join(process.env.DSH_HOME, "launches.txt"),',
          '  `${process.env.MINKE_LM_STUDIO_ENABLED}\\n`,',
          ");",
          `process.stdout.write(${JSON.stringify(`dsh web: ${HARNESS_AUTHENTICATED_URL.slice(0, -12)}`)});`,
          `setTimeout(() => { process.stdout.write(${JSON.stringify(`${HARNESS_AUTHENTICATED_URL.slice(-12)}\n`)}); process.send({ type: "ready", url: ${JSON.stringify(HARNESS_AUTHENTICATED_URL)} }); }, 5);`,
          'process.on("message", (message) => {',
          '  if (message?.type === "shutdown") { process.send({ type: "shutdown-complete" }, () => process.disconnect()); return; }',
          '  if (message?.type !== "model-runtimes/reconfigure") return;',
          '  const response = {',
          "    channel: message.channel,",
          "    protocolVersion: message.protocolVersion,",
          "    requestId: message.requestId,",
          "    type: message.mode === \"rollback\"",
          '      ? "model-runtimes/error"',
          '      : "model-runtimes/reconfigured",',
          '    ...(message.mode === "rollback"',
          '      ? { message: "rollback crashed" }',
          "      : {}),",
          "  };",
          "  process.send(response, () => {",
          '    if (message.mode === "rollback") process.exit(17);',
          "  });",
          "});",
          "setInterval(() => {}, 1_000).unref();",
          "",
        ].join("\n"),
      ),
    ]);

    runtime = new HarnessRuntime({
      runtimeRoot,
      dshHome,
      electronExecutable: process.execPath,
      modelRuntimes: {
        lmStudio: { enabled: false },
        ollama: { enabled: false },
      },
      pluginManagement: {
        safeMode: false,
        disabledPlugins: [],
      },
      onUnexpectedExit(exit) {
        resolveCrash(exit);
      },
      startupTimeoutMs: 2_000,
      shutdownTimeoutMs: 2_000,
      controlTimeoutMs: 500,
      modelRuntimeControlTimeoutMs: 2_000,
    });
    await runtime.start();

    const persisted = {
      lmStudio: { enabled: false },
      ollama: { enabled: false },
    };
    binding = bindModelRuntimeSettingsIpc(
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
        await runtime.reconfigureModelRuntimes(settings, mode);
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
      /persistence failed and live rollback also failed/u,
    );
    const exit = await crashed;
    assert.equal(exit.code, 17);
    assert.match(exit.output, /token=<redacted>/u);
    assert.doesNotMatch(exit.output, new RegExp(HARNESS_LAUNCH_TOKEN, "u"));

    await runtime.start();
    assert.equal(
      await readFile(launchesPath, "utf8"),
      "0\n0\n",
    );
  } finally {
    binding?.dispose();
    await runtime?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("model-runtime control messages reject non-exact payloads", () => {
  const request = createReconfigureModelRuntimesRequest(1, {
    lmStudio: { enabled: true },
    ollama: { enabled: false },
  });
  assert.deepEqual(
    parseReconfigureModelRuntimesRequest(request),
    request,
  );
  const targeted = createReconfigureModelRuntimesRequest(2, request.settings, "rollback", "ollama");
  assert.deepEqual(parseReconfigureModelRuntimesRequest(targeted), targeted);
  for (const runtimeId of [null, undefined, "unknown-service", 1]) {
    assert.throws(() => parseReconfigureModelRuntimesRequest({ ...request, runtimeId }), /runtime/u);
  }
  assert.throws(
    () => parseReconfigureModelRuntimesRequest({
      ...request,
      unexpected: true,
    }),
    /invalid model runtime control request/u,
  );
  assert.throws(
    () => parseModelRuntimeControlResponse({
      ...modelRuntimesReconfiguredResponse(1),
      unexpected: true,
    }),
    /invalid model runtime control response/u,
  );
});

test("targeted service settings update only their own crash-recovery launch state", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-scoped-model-runtime-"));
  const runtimeRoot = join(root, "runtime");
  const dshHome = join(root, "data");
  let runtime;
  try {
    const patchRoot = join(runtimeRoot, "node_modules", "@lencx", "minke-harness-overlay");
    const pnpmRoot = join(runtimeRoot, "node_modules", "pnpm", "bin");
    await Promise.all([patchRoot, pnpmRoot, dshHome, join(runtimeRoot, "bin")].map(
      async (path) => mkdir(path, { recursive: true }),
    ));
    await Promise.all([
      writeFile(join(runtimeRoot, "dsh-runtime.json"), JSON.stringify({
        schemaVersion: 3,
        productBundle: { packageName: "@lencx/minke-harness-overlay", patch: "cordis.patch.yml" },
      })),
      writeFile(join(patchRoot, "cordis.patch.yml"), ""),
      writeFile(join(pnpmRoot, "pnpm.cjs"), ""),
      writeFile(join(runtimeRoot, "index.mjs"), `
        import { appendFile } from "node:fs/promises";
        import { join } from "node:path";
        await appendFile(join(process.env.DSH_HOME, "launches.jsonl"), JSON.stringify({
          lmStudio: process.env.MINKE_LM_STUDIO_ENABLED,
          ollama: process.env.MINKE_OLLAMA_ENABLED,
          loginMarker: process.env.LOGIN_SHELL_FIXTURE,
        }) + "\\n");
        process.stdout.write(${JSON.stringify(`dsh web: ${HARNESS_AUTHENTICATED_URL}\n`)});
        process.send({ type: "ready", url: ${JSON.stringify(HARNESS_AUTHENTICATED_URL)} });
        process.on("message", async (message) => {
          if (message?.type === "shutdown") { process.send({ type: "shutdown-complete" }, () => process.disconnect()); return; }
          if (message?.type !== "model-runtimes/reconfigure") return;
          await appendFile(join(process.env.DSH_HOME, "requests.jsonl"), JSON.stringify(message) + "\\n");
          process.send({
            channel: message.channel, protocolVersion: message.protocolVersion,
            requestId: message.requestId, type: "model-runtimes/reconfigured",
          });
        });
      `),
    ]);
    runtime = new HarnessRuntime({
      runtimeRoot, dshHome, electronExecutable: process.execPath,
      environment: { ...process.env, LOGIN_SHELL_FIXTURE: "configured-shell" },
      modelRuntimes: { lmStudio: { enabled: false }, ollama: { enabled: false } },
      pluginManagement: { safeMode: false, disabledPlugins: [] },
      startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000, modelRuntimeControlTimeoutMs: 2_000,
    });
    await runtime.start();
    // A persisted LM Studio opt-in may differ from launch state if its CLI
    // was absent at boot. An Ollama update must preserve that launch state.
    const settings = { lmStudio: { enabled: true }, ollama: { enabled: true } };
    await runtime.reconfigureModelRuntimes(settings, "apply", "ollama");
    await assert.rejects(runtime.reconfigureModelRuntimes(settings, "finalize", "lmStudio"), /no matching staged apply/u);
    await runtime.reconfigureModelRuntimes(settings, "finalize", "ollama");
    const reverted = { ...settings, ollama: { enabled: false } };
    await runtime.reconfigureModelRuntimes(reverted, "apply", "ollama");
    await runtime.reconfigureModelRuntimes(settings, "rollback", "ollama");
    await assert.rejects(runtime.reconfigureModelRuntimes(reverted, "finalize", "ollama"), /no matching staged apply/u);
    await runtime.stop();
    await runtime.start();
    const readJsonLines = async (name) => (await readFile(join(dshHome, name), "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(await readJsonLines("launches.jsonl"), [
      { lmStudio: "0", ollama: "0", loginMarker: "configured-shell" },
      { lmStudio: "0", ollama: "1", loginMarker: "configured-shell" },
    ]);
    const requests = await readJsonLines("requests.jsonl");
    assert.deepEqual(requests.map(({ runtimeId, mode }) => ({ runtimeId, mode })), [
      { runtimeId: "ollama", mode: "apply" },
      { runtimeId: "ollama", mode: "apply" },
      { runtimeId: "ollama", mode: "rollback" },
    ]);
  } finally {
    await runtime?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("Harness window navigation cannot leave the bootstrap pending forever", async () => {
  let navigationStops = 0;
  let remoteStarts = 0;
  let loadedUrl;
  const lifecycle = new HarnessLifecycle({
    runtime: {
      async start() {
        return harnessEndpoint();
      },
    },
    remote: {
      async start() {
        remoteStarts += 1;
      },
      async detach() {},
    },
    navigationTimeoutMs: 10,
  });
  const navigation = lifecycle.start({
    isDestroyed() {
      return false;
    },
    async loadURL(url) {
      loadedUrl = url;
      return await new Promise(() => {});
    },
    webContents: {
      getURL() {
        return "data:text/html,bootstrap";
      },
      isDestroyed() {
        return false;
      },
      isLoadingMainFrame() {
        return false;
      },
      stop() {
        navigationStops += 1;
      },
    },
  });
  const outcome = await Promise.race([
    navigation.then(
      () => "resolved",
      (error) => error,
    ),
    new Promise((resolve) => {
      setTimeout(() => resolve("still-pending"), 50);
    }),
  ]);

  assert.notEqual(
    outcome,
    "still-pending",
    "Harness navigation must settle before the external deadline",
  );
  assert.equal(outcome?.name, "HarnessNavigationError");
  assert.match(outcome?.message, /did not finish within 10 ms/u);
  assert.equal(lifecycle.url, HARNESS_ORIGIN);
  assert.equal(loadedUrl, HARNESS_AUTHENTICATED_URL);
  assert.equal(navigationStops, 1);
  assert.equal(remoteStarts, 0);
});

test("Harness navigation accepts a loaded target when Electron loses its completion signal", async () => {
  let navigationStops = 0;
  let remoteStarts = 0;
  const lifecycle = new HarnessLifecycle({
    runtime: {
      async start() {
        return harnessEndpoint();
      },
    },
    remote: {
      async start() {
        remoteStarts += 1;
      },
      async detach() {},
    },
    navigationTimeoutMs: 10,
  });

  assert.equal(
    await lifecycle.start({
      isDestroyed() {
        return false;
      },
      async loadURL() {
        return await new Promise(() => {});
      },
      webContents: {
        getURL() {
          return HARNESS_ORIGIN;
        },
        isDestroyed() {
          return false;
        },
        isLoadingMainFrame() {
          return false;
        },
        stop() {
          navigationStops += 1;
        },
      },
    }),
    HARNESS_ORIGIN,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(navigationStops, 0);
  assert.equal(remoteStarts, 1);
});

test("remote exposure starts only after the Harness window has loaded", async () => {
  const events = [];
  const lifecycle = new HarnessLifecycle({
    runtime: {
      async start() {
        events.push("runtime");
        return harnessEndpoint();
      },
    },
    remote: {
      async start(url, launchToken) {
        events.push(["remote", url, launchToken]);
      },
      async detach() {
        events.push("remote-detach");
      },
    },
    navigationTimeoutMs: 50,
  });

  assert.equal(
    await lifecycle.start({
      isDestroyed() {
        return false;
      },
      async loadURL(url) {
        events.push(["window", url]);
      },
      webContents: {
        isDestroyed() {
          return false;
        },
        stop() {
          events.push("window-stop");
        },
      },
    }),
    HARNESS_ORIGIN,
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    "remote-detach",
    "runtime",
    ["window", HARNESS_AUTHENTICATED_URL],
    ["remote", HARNESS_ORIGIN, HARNESS_LAUNCH_TOKEN],
  ]);
});

test("Harness navigation errors redact the launch capability", async () => {
  let remoteStarts = 0;
  const lifecycle = new HarnessLifecycle({
    runtime: {
      async start() {
        return harnessEndpoint();
      },
    },
    remote: {
      async start() {
        remoteStarts += 1;
      },
      async detach() {},
    },
  });

  await assert.rejects(
    lifecycle.start({
      isDestroyed() {
        return false;
      },
      async loadURL(url) {
        throw new Error(`navigation failed for ${url}`);
      },
      webContents: {
        isDestroyed() {
          return false;
        },
        stop() {},
      },
    }),
    (error) =>
      error?.name === "HarnessNavigationError" &&
      error.message.includes(HARNESS_ORIGIN) &&
      !error.message.includes(HARNESS_LAUNCH_TOKEN) &&
      error.cause instanceof Error &&
      error.cause.message.includes("token=<redacted>") &&
      !error.cause.message.includes(HARNESS_LAUNCH_TOKEN),
  );
  assert.equal(remoteStarts, 0);
  assert.equal(lifecycle.url, HARNESS_ORIGIN);
});

function navigationFixture(options = {}) {
  const attempts = [];
  let runtimeStarts = 0;
  let remoteStarts = 0;
  let stops = 0;
  let loading = true;
  let destroyed = false;
  const lifecycle = new HarnessLifecycle({
    runtime: {
      async start() {
        runtimeStarts += 1;
        return harnessEndpoint();
      },
    },
    remote: {
      async detach() {},
      async start() {
        remoteStarts += 1;
      },
    },
    ...options,
  });
  const window = {
    isDestroyed: () => destroyed,
    loadURL(url) {
      loading = true;
      const attempt = Promise.withResolvers();
      attempts.push({ url, ...attempt });
      return attempt.promise;
    },
    webContents: {
      isDestroyed: () => destroyed,
      getURL: () => HARNESS_ORIGIN,
      isLoadingMainFrame: () => loading,
      stop() {
        stops += 1;
        attempts.at(-1).reject(new Error("ERR_ABORTED"));
      },
    },
  };
  return {
    lifecycle,
    window,
    attempts,
    counts: () => ({ runtimeStarts, remoteStarts, stops }),
    finish() {
      loading = false;
      attempts.at(-1).resolve();
    },
    destroy() {
      destroyed = true;
    },
  };
}

const nextNavigationTurn = () => new Promise(setImmediate);

test("default startup allows a page that needs 20 seconds to load (#18)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = navigationFixture();
  const outcome = fixture.lifecycle.start(fixture.window).catch(
    (error) => error,
  );
  await nextNavigationTurn();

  t.mock.timers.tick(20_000);
  fixture.finish();

  assert.equal(await outcome, HARNESS_ORIGIN);
  assert.deepEqual(fixture.counts(), {
    runtimeStarts: 1,
    remoteStarts: 1,
    stops: 0,
  });
});

test("default navigation remains bounded at 90 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fixture = navigationFixture();
  const outcome = fixture.lifecycle.start(fixture.window).catch(
    (error) => error,
  );
  await nextNavigationTurn();

  t.mock.timers.tick(89_999);
  assert.equal(fixture.counts().stops, 0);
  t.mock.timers.tick(1);
  const error = await outcome;
  assert.equal(error.name, "HarnessNavigationError");
  assert.match(error.message, /did not finish within 90000 ms/u);
  assert.deepEqual(fixture.counts(), {
    runtimeStarts: 1,
    remoteStarts: 0,
    stops: 1,
  });
});

test("navigation retry reuses the ready runtime and waits before remote exposure", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const decision = Promise.withResolvers();
  const errors = [];
  const fixture = navigationFixture({
    navigationTimeoutMs: 20,
    requestNavigationRetry(error) {
      errors.push(error);
      return decision.promise;
    },
  });
  const outcome = fixture.lifecycle.start(fixture.window).catch(
    (error) => error,
  );
  await nextNavigationTurn();
  t.mock.timers.tick(20);
  await nextNavigationTurn();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "HarnessNavigationError");
  assert.deepEqual(fixture.counts(), {
    runtimeStarts: 1,
    remoteStarts: 0,
    stops: 1,
  });

  decision.resolve(true);
  await nextNavigationTurn();
  assert.deepEqual(
    fixture.attempts.map(({ url }) => url),
    [HARNESS_AUTHENTICATED_URL, HARNESS_AUTHENTICATED_URL],
  );
  t.mock.timers.tick(19);
  fixture.finish();
  assert.equal(await outcome, HARNESS_ORIGIN);
  assert.equal(fixture.counts().remoteStarts, 1);

  const attached = fixture.lifecycle.attach(fixture.window);
  assert.equal(fixture.attempts.at(-1).url, HARNESS_ORIGIN);
  fixture.finish();
  await attached;
  assert.equal(fixture.counts().runtimeStarts, 1);
});

test("declining navigation retry preserves the failure without reloading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors = [];
  const fixture = navigationFixture({
    navigationTimeoutMs: 20,
    async requestNavigationRetry(error) {
      errors.push(error);
      return false;
    },
  });
  const outcome = fixture.lifecycle.start(fixture.window).catch(
    (error) => error,
  );
  await nextNavigationTurn();
  t.mock.timers.tick(20);
  const error = await outcome;
  assert.equal(errors.length, 1);
  assert.equal(error, errors[0]);
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.counts().remoteStarts, 0);
});

test("closing the window while choosing retry cannot start another navigation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const decision = Promise.withResolvers();
  const fixture = navigationFixture({
    navigationTimeoutMs: 20,
    requestNavigationRetry: () => decision.promise,
  });
  const outcome = fixture.lifecycle.start(fixture.window).catch(
    (error) => error,
  );
  await nextNavigationTurn();
  t.mock.timers.tick(20);
  await nextNavigationTurn();
  fixture.destroy();
  decision.resolve(true);
  assert.equal((await outcome).name, "HarnessNavigationError");
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.counts().remoteStarts, 0);
});

test("a replaced runtime cannot be reloaded by an old retry decision", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const decision = Promise.withResolvers();
  const fixture = navigationFixture({
    navigationTimeoutMs: 20,
    requestNavigationRetry: () => decision.promise,
  });
  const outcome = fixture.lifecycle.start(fixture.window).catch(
    (error) => error,
  );
  await nextNavigationTurn();
  t.mock.timers.tick(20);
  await nextNavigationTurn();
  fixture.lifecycle.clear();
  decision.resolve(true);
  assert.equal((await outcome).name, "HarnessNavigationError");
  assert.equal(fixture.attempts.length, 1);
  assert.equal(fixture.counts().remoteStarts, 0);
});

test("failed page loads offer retry without exposing the launch token", async () => {
  const errors = [];
  const fixture = navigationFixture({
    async requestNavigationRetry(error) {
      errors.push(error);
      return true;
    },
  });
  const outcome = fixture.lifecycle.start(fixture.window);
  await nextNavigationTurn();
  fixture.attempts[0].reject(new Error(
    `ERR_CONNECTION_RESET ${HARNESS_AUTHENTICATED_URL}`,
  ));
  await nextNavigationTurn();
  assert.equal(fixture.attempts.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, "HarnessNavigationError");
  assert.doesNotMatch(errors[0].message, new RegExp(HARNESS_LAUNCH_TOKEN, "u"));
  assert.match(errors[0].cause.message, /ERR_CONNECTION_RESET.*token=<redacted>/u);
  fixture.finish();
  assert.equal(await outcome, HARNESS_ORIGIN);
  assert.equal(fixture.counts().runtimeStarts, 1);
});

test("backend startup failures do not enter the page reload loop", async () => {
  const failure = new Error("backend failed before readiness");
  let retries = 0;
  const fixture = navigationFixture({
    runtime: { async start() { throw failure; } },
    async requestNavigationRetry() {
      retries += 1;
      return true;
    },
  });
  await assert.rejects(fixture.lifecycle.start(fixture.window), (error) => error === failure);
  assert.equal(retries, 0);
  assert.equal(fixture.attempts.length, 0);
});

test("Harness timeouts have independent environment overrides and explicit precedence", () => {
  for (const phase of ["startup", "navigation"]) {
    assert.equal(resolveHarnessTimeout(phase, undefined, {}), 90_000);
    const name = `MINKE_HARNESS_${phase.toUpperCase()}_TIMEOUT_MS`;
    const environment = { [name.toLowerCase()]: " 180000 " };
    assert.equal(resolveHarnessTimeout(phase, undefined, environment), 180_000);
    assert.equal(resolveHarnessTimeout(phase, 1_000, environment), 1_000);
    assert.equal(resolveHarnessTimeout(phase, undefined, { [name]: " " }), 90_000);
  }
  const environment = { MINKE_HARNESS_STARTUP_TIMEOUT_MS: "120000" };
  assert.equal(resolveHarnessTimeout("startup", undefined, environment), 120_000);
  assert.equal(resolveHarnessTimeout("navigation", undefined, environment), 90_000);
});

test("Harness timeout overrides reject invalid and overflowing timers", () => {
  for (const value of ["0", "-1", "1.5", "Infinity", "NaN", "120s", "1e5", "2147483648"]) {
    assert.throws(
      () => resolveHarnessTimeout("navigation", undefined, {
        MINKE_HARNESS_NAVIGATION_TIMEOUT_MS: value,
      }),
      /MINKE_HARNESS_NAVIGATION_TIMEOUT_MS must be a whole number of milliseconds/u,
      value,
    );
  }
  for (const value of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => resolveHarnessTimeout("startup", value, {}), RangeError);
  }
});

test("the navigation environment override reaches the actual loading timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const environment = process.env;
  process.env = { ...environment, MINKE_HARNESS_NAVIGATION_TIMEOUT_MS: "180000" };
  t.after(() => { process.env = environment; });
  const fixture = navigationFixture();
  const outcome = fixture.lifecycle.start(fixture.window).catch((error) => error);
  await nextNavigationTurn();
  t.mock.timers.tick(120_000);
  fixture.finish();
  assert.equal(await outcome, HARNESS_ORIGIN);
  assert.equal(fixture.counts().stops, 0);
});

test("nonzero Host shutdown exits publish a retained teardown diagnostic", async () => {
  await withRuntime({ schemaVersion: 3, productBundle: {
    packageName: "@lencx/minke-harness-overlay", patch: "cordis.patch.yml",
  } }, async runtimeRoot => {
    const patch = join(runtimeRoot, "node_modules", "@lencx", "minke-harness-overlay");
    const pnpm = join(runtimeRoot, "node_modules", "pnpm", "bin");
    const home = join(runtimeRoot, "home");
    await Promise.all([patch, pnpm, home, join(runtimeRoot, "bin")].map(path => mkdir(path, { recursive: true })));
    await Promise.all([
      writeFile(join(patch, "cordis.patch.yml"), ""), writeFile(join(pnpm, "pnpm.cjs"), ""),
      writeFile(join(runtimeRoot, "index.mjs"), `
        process.send({ type: "ready", url: ${JSON.stringify(HARNESS_AUTHENTICATED_URL)} });
        process.on("message", message => { if (message.type === "shutdown") process.exit(7); });
      `),
    ]);
    const diagnostics = [];
    const runtime = new HarnessRuntime({ runtimeRoot, dshHome: home, electronExecutable: process.execPath,
      modelRuntimes: { lmStudio: { enabled: false }, ollama: { enabled: false } },
      pluginManagement: { safeMode: false, disabledPlugins: [] }, startupTimeoutMs: 2_000, shutdownTimeoutMs: 2_000,
      onUnexpectedExit: () => { throw new Error("requested shutdown is not a running crash"); },
      onShutdownDiagnostic: error => diagnostics.push(error),
    });
    try {
      await runtime.start();
      await runtime.stop();
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0].message, /exit 7.*acknowledged false/);
      assert.doesNotMatch(diagnostics[0].message, new RegExp(HARNESS_LAUNCH_TOKEN));
    } finally { await runtime.stop(); }
  });
});
