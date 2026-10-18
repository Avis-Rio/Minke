import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import {
  deleteEnvironmentName,
  embeddedNodeChildEnvironment,
  setEnvironmentName,
} from "../../config/embedded-node-runtime.mts";
import {
  type LocalModelRuntimeId,
  type ModelRuntimeSettings,
} from "@lencx/minke-model-runtime/contract";
import type {
  PluginManagementSettings,
} from "@minke/harness-overlay/plugin-recovery-contract";
import {
  DEFAULT_PLUGIN_MANAGEMENT_SETTINGS,
} from "@minke/harness-overlay/plugin-recovery-contract";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV,
  type WebSearchSettings,
} from "@minke/harness-overlay/web-search-settings-contract.ts";
import type {
  AgentTurnInput,
  AgentTurnResult,
} from "@minke/harness-overlay/agent-turn-contract.ts";
import {
  AGENT_BROWSER_IPC_VERSION_ENV,
  AGENT_BROWSER_PROTOCOL_VERSION,
} from "@minke/harness-overlay/agent-browser-contract.ts";
import {
  harnessHostArguments,
  readHarnessRuntimeLayout,
  type HarnessRuntimeLayout,
} from "./harness-launch.ts";
import {
  HarnessControlChannel,
} from "./harness-control.ts";
import type {
  ModelRuntimeSettingsTransactionPhase,
} from "./model-runtime-settings.ts";
import type {
  AgentBrowserBinding,
  AgentBrowserRuntime,
} from "./agent-browser";
import { HarnessHostChannel, redactLaunchTokens, type DesktopQuitInspection } from "./harness-host-channel.ts";
import { resolveHarnessTimeout } from "./harness-timeout.ts";

const LAUNCH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_CAPTURED_OUTPUT = 64 * 1024;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface HarnessRuntimeEndpoint {
  /** Clean loopback origin safe for persistence, diagnostics, and proxies. */
  readonly origin: string;
  /** Ephemeral startup capability used only for browser cookie bootstrap. */
  readonly authenticatedUrl: string;
  /** Process-local capability needed to bootstrap a different authority. */
  readonly launchToken: string;
}

export interface HarnessRuntimeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

export interface HarnessRuntimeOptions {
  runtimeRoot: string;
  dshHome: string;
  electronExecutable: string;
  environment?: NodeJS.ProcessEnv;
  modelRuntimes: LocalModelRuntimeLaunchOptions;
  pluginManagement: PluginManagementSettings;
  webSearch: WebSearchSettings;
  agentBrowser?: Pick<AgentBrowserRuntime, "bindChild">;
  onUnexpectedExit(exit: HarnessRuntimeExit): void;
  onShutdownDiagnostic?(error: Error): void;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  controlTimeoutMs?: number;
  modelRuntimeControlTimeoutMs?: number;
  agentTurnTimeoutMs?: number;
}

export type LocalModelRuntimeLaunchOptions = Record<
  LocalModelRuntimeId,
  {
    enabled: boolean;
    command?: string;
  }
>;

type HarnessRuntimeEnvironmentOptions = Pick<
  HarnessRuntimeOptions,
  | "dshHome"
  | "electronExecutable"
  | "modelRuntimes"
  | "agentBrowser"
> & {
  pluginManagement?: PluginManagementSettings;
  webSearch?: WebSearchSettings;
};

const LOCAL_MODEL_ENVIRONMENT = [
  {
    id: "lmStudio",
    enabled: "MINKE_LM_STUDIO_ENABLED",
    command: "MINKE_LM_STUDIO_COMMAND",
  },
  {
    id: "ollama",
    enabled: "MINKE_OLLAMA_ENABLED",
    command: "MINKE_OLLAMA_COMMAND",
  },
] as const satisfies readonly {
  id: LocalModelRuntimeId;
  enabled: string;
  command: string;
}[];

/** Build the explicit child environment without inheriting stale Minke flags. */
export function harnessRuntimeEnvironment(
  layout: Pick<HarnessRuntimeLayout, "pnpmEntry" | "runtimeBin">,
  options: HarnessRuntimeEnvironmentOptions,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = embeddedNodeChildEnvironment(
    {
      electronExecutable: options.electronExecutable,
      pnpmEntry: layout.pnpmEntry,
      runtimeBin: layout.runtimeBin,
    },
    inherited,
  );
  setEnvironmentName(environment, "DSH_HOME", options.dshHome);
  const pluginManagement =
    options.pluginManagement ??
    DEFAULT_PLUGIN_MANAGEMENT_SETTINGS;
  setEnvironmentName(
    environment,
    "MINKE_PLUGIN_SAFE_MODE",
    pluginManagement.safeMode ? "1" : "0",
  );
  deleteEnvironmentName(environment, "MINKE_DISABLED_PLUGINS");
  const webSearch =
    options.webSearch ?? DEFAULT_WEB_SEARCH_SETTINGS;
  setEnvironmentName(
    environment,
    MINKE_WEB_SEARCH_FALLBACK_ENABLED_ENV,
    webSearch.fallbackEnabled ? "1" : "0",
  );
  deleteEnvironmentName(
    environment,
    AGENT_BROWSER_IPC_VERSION_ENV,
  );
  if (options.agentBrowser !== undefined) {
    setEnvironmentName(
      environment,
      AGENT_BROWSER_IPC_VERSION_ENV,
      String(AGENT_BROWSER_PROTOCOL_VERSION),
    );
  }
  deleteEnvironmentName(environment, "MINKE_HOST_ROOT");
  for (const descriptor of LOCAL_MODEL_ENVIRONMENT) {
    const runtime = options.modelRuntimes[descriptor.id];
    setEnvironmentName(
      environment,
      descriptor.enabled,
      runtime.enabled ? "1" : "0",
    );
    const command = runtime.command?.trim();
    setEnvironmentName(
      environment,
      descriptor.command,
      command === undefined || command === ""
        ? undefined
        : command,
    );
  }
  return environment;
}

/**
 * Owns the complete Harness process lifecycle. Callers only need to start and
 * stop it; runtime layout, Electron-as-Node, readiness parsing, PATH injection,
 * output capture, and process-tree termination stay behind this interface.
 */
export class HarnessRuntime {
  readonly #options: HarnessRuntimeOptions;
  readonly #startupTimeoutMs: number;
  #modelRuntimes: LocalModelRuntimeLaunchOptions;
  #stagedModelRuntimes:
    | {
        settings: LocalModelRuntimeLaunchOptions;
        runtimeId: LocalModelRuntimeId | undefined;
      }
    | undefined;
  #modelRuntimeTail: Promise<void> = Promise.resolve();
  #child: ChildProcess | undefined;
  #control: HarnessControlChannel | undefined;
  #agentBrowserBinding: AgentBrowserBinding | undefined;
  #output = "";
  #rawOutput = "";
  #host: HarnessHostChannel | undefined;
  #stopPromise: Promise<void> | undefined;
  #stopping = false;
  #starting = false;
  #ready = false;

  constructor(options: HarnessRuntimeOptions) {
    this.#options = options;
    this.#startupTimeoutMs = resolveHarnessTimeout(
      "startup",
      options.startupTimeoutMs,
    );
    this.#modelRuntimes = copyModelRuntimes(
      options.modelRuntimes,
    );
  }

  start(): Promise<HarnessRuntimeEndpoint> {
    if (this.#starting || this.#child !== undefined) {
      return Promise.reject(new Error("Harness runtime is already running"));
    }
    this.#starting = true;
    this.#stopping = false;
    this.#stopPromise = undefined;
    return this.#start().finally(() => { this.#starting = false; });
  }

  async #start(): Promise<HarnessRuntimeEndpoint> {
    const layout = await readHarnessRuntimeLayout(this.#options.runtimeRoot);
    if (this.#stopping) throw new Error("Harness stopped during startup");
    await Promise.all([
      access(layout.entryPath),
      access(layout.pnpmEntry),
      access(layout.runtimeBin),
      access(layout.productPatch),
    ]);
    await mkdir(this.#options.dshHome, { recursive: true });
    if (this.#stopping) throw new Error("Harness stopped during startup");

    this.#output = "";
    this.#rawOutput = "";
    this.#ready = false;

    const child = spawn(
      this.#options.electronExecutable,
      harnessHostArguments(layout),
      {
        cwd: this.#options.dshHome,
        detached: process.platform !== "win32",
        env: harnessRuntimeEnvironment(layout, {
          ...this.#options,
          modelRuntimes: this.#modelRuntimes,
        }, this.#options.environment),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    this.#child = child;
    const host = new HarnessHostChannel(child, this.#startupTimeoutMs, () => this.#output);
    this.#host = host;
    this.#control = new HarnessControlChannel(
      child,
      this.#options.controlTimeoutMs,
      this.#options.modelRuntimeControlTimeoutMs,
      this.#options.agentTurnTimeoutMs,
    );
    const agentBrowserBinding =
      this.#options.agentBrowser?.bindChild(child);
    this.#agentBrowserBinding = agentBrowserBinding;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#capture(chunk));
    child.stderr?.on("data", (chunk: string) => this.#capture(chunk));

    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = undefined;
      this.#control?.dispose();
      this.#control = undefined;
      agentBrowserBinding?.dispose();
      if (this.#agentBrowserBinding === agentBrowserBinding) {
        this.#agentBrowserBinding = undefined;
      }
      const exit = { code, signal, output: host.diagnostic ?? this.#output };
      host.dispose();
      if (this.#host === host) this.#host = undefined;
      if (this.#ready && !this.#stopping) {
        this.#options.onUnexpectedExit(exit);
      }
    });

    try {
      const endpoint = parseHarnessRuntimeEndpoint(await host.ready);
      if (this.#stopping || this.#child !== child) throw new Error("Harness stopped during startup");
      this.#ready = true;
      return endpoint;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  /** Replace trusted remote authorities without restarting Harness. */
  replaceTrustedHosts(
    trustedHosts: readonly string[],
  ): Promise<void> {
    const control = this.#control;
    if (control === undefined || !this.#ready) {
      return Promise.reject(
        new Error("Harness runtime is not ready"),
      );
    }
    return control.replaceTrustedHosts(trustedHosts);
  }

  /** Run or recover one durable Agent turn in the live Harness process. */
  runAgentTurn(
    input: AgentTurnInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AgentTurnResult> {
    const control = this.#control;
    if (control === undefined || !this.#ready) {
      return Promise.reject(
        new Error("Harness runtime is not ready"),
      );
    }
    return control.runAgentTurn(input, options);
  }

  /**
   * Reconcile local runtimes transactionally. An apply ACK stages the desired
   * launch state, but only finalize may advance crash recovery after the
   * settings store has committed. Rollback always discards the staged state,
   * including when live rollback itself fails.
   */
  reconfigureModelRuntimes(
    settings: ModelRuntimeSettings,
    mode: ModelRuntimeSettingsTransactionPhase = "apply",
    runtimeId?: LocalModelRuntimeId,
  ): Promise<void> {
    if (mode === "finalize") {
      const staged = this.#stagedModelRuntimes;
      if (
        staged === undefined ||
        staged.runtimeId !== runtimeId ||
        !sameModelRuntimeSettings(staged.settings, settings, runtimeId)
      ) {
        return Promise.reject(
          new Error(
            "model-runtime transaction has no matching staged apply",
          ),
        );
      }
      this.#modelRuntimes = staged.settings;
      this.#stagedModelRuntimes = undefined;
      return Promise.resolve();
    }
    const operation = this.#modelRuntimeTail.then(async () => {
      const control = this.#control;
      if (control === undefined || !this.#ready) {
        throw new Error("Harness runtime is not ready");
      }
      if (
        mode === "apply" &&
        this.#stagedModelRuntimes !== undefined
      ) {
        throw new Error(
          "model-runtime transaction already has a staged apply",
        );
      }
      try {
        await control.reconfigureModelRuntimes(settings, mode, runtimeId);
        if (mode === "apply") {
          this.#stagedModelRuntimes = {
            settings: modelRuntimesWithSettings(
              this.#modelRuntimes,
              settings,
              runtimeId,
            ),
            runtimeId,
          };
        }
      } finally {
        if (mode === "rollback") {
          this.#stagedModelRuntimes = undefined;
        }
      }
    });
    this.#modelRuntimeTail = operation.catch(() => undefined);
    return operation;
  }

  /** Undefined before readiness; a missing answer from a ready Host is an error. */
  inspectQuit(): Promise<DesktopQuitInspection> | undefined {
    if (!this.#ready) return undefined;
    return this.#host?.inspectQuit() ?? Promise.reject(new Error("Desktop Host is unavailable"));
  }

  stop(): Promise<void> {
    this.#stopping = true;
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    const operation = this.#stop();
    this.#stopPromise = operation;
    void operation.catch(() => {
      if (this.#stopPromise === operation) this.#stopPromise = undefined;
    });
    return operation;
  }

  async #stop(): Promise<void> {
    const child = this.#child;
    if (child === undefined) return;
    this.#stopping = true;
    const host = this.#host;
    host?.requestShutdown();
    const graceful = await this.#waitForExit(child,
      this.#options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    let exited = graceful;
    if (!exited) {
      this.#signalProcessTree(child, "SIGTERM");
      exited = await this.#waitForExit(child, 5_000);
    }
    if (!exited) {
      this.#signalProcessTree(child, "SIGKILL");
      exited = await this.#waitForExit(child, 1_000);
    }
    if (!exited) throw new Error("Harness did not exit after forced termination");
    if (!graceful || !host?.shutdownCompleted || child.exitCode !== 0) {
      const error = new Error(`Harness teardown incomplete (exit ${String(child.exitCode)}, signal ${String(child.signalCode)}, acknowledged ${String(host?.shutdownCompleted ?? false)}, graceful deadline exceeded ${String(!graceful)})\n${host?.diagnostic ?? this.#output}`);
      console.warn(error);
      this.#options.onShutdownDiagnostic?.(error);
    }
    if (this.#child === child) this.#child = undefined;
    host?.dispose();
    if (this.#host === host) this.#host = undefined;
    this.#control?.dispose();
    this.#control = undefined;
    this.#agentBrowserBinding?.dispose();
    this.#agentBrowserBinding = undefined;
    this.#ready = false;
  }

  #capture(chunk: string): void {
    this.#rawOutput = `${this.#rawOutput}${chunk}`.slice(-MAX_CAPTURED_OUTPUT);
    this.#output = redactLaunchTokens(this.#rawOutput);
  }

  #signalProcessTree(
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): void {
    if (child.pid === undefined || child.exitCode !== null) return;
    try {
      if (process.platform === "win32") {
        child.kill(signal);
      } else {
        process.kill(-child.pid, signal);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw error;
    }
  }

  async #waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolvePromise) => {
      const timeout = setTimeout(() => {
        child.off("exit", onExit);
        resolvePromise(false);
      }, timeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolvePromise(true);
      };
      child.once("exit", onExit);
    });
  }
}

function copyModelRuntimes(
  value: LocalModelRuntimeLaunchOptions,
): LocalModelRuntimeLaunchOptions {
  return {
    lmStudio: { ...value.lmStudio },
    ollama: { ...value.ollama },
  };
}

function modelRuntimesWithSettings(
  current: LocalModelRuntimeLaunchOptions,
  settings: ModelRuntimeSettings,
  runtimeId?: LocalModelRuntimeId,
): LocalModelRuntimeLaunchOptions {
  const next = copyModelRuntimes(current);
  for (const descriptor of LOCAL_MODEL_ENVIRONMENT) {
    if (runtimeId !== undefined && descriptor.id !== runtimeId) continue;
    next[descriptor.id].enabled =
      settings[descriptor.id].enabled;
  }
  return next;
}

function sameModelRuntimeSettings(
  launch: LocalModelRuntimeLaunchOptions,
  settings: ModelRuntimeSettings,
  runtimeId?: LocalModelRuntimeId,
): boolean {
  return LOCAL_MODEL_ENVIRONMENT.every(
    ({ id }) =>
      (runtimeId !== undefined && id !== runtimeId) ||
      launch[id].enabled === settings[id].enabled,
  );
}

/** Parse the exact tokenized readiness contract without exposing its secret. */
export function parseHarnessRuntimeEndpoint(
  value: string,
): HarnessRuntimeEndpoint {
  try {
    const url = new URL(value);
    const entries = [...url.searchParams];
    const launchToken = entries[0]?.[1];
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.port === "" ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.hash !== "" ||
      entries.length !== 1 ||
      entries[0]?.[0] !== "token" ||
      launchToken === undefined ||
      !LAUNCH_TOKEN_PATTERN.test(launchToken) ||
      value !== url.href
    ) {
      throw new TypeError("invalid endpoint");
    }
    return Object.freeze({
      origin: url.origin,
      authenticatedUrl: url.href,
      launchToken,
    });
  } catch {
    throw new Error(
      "Harness published an invalid authenticated readiness URL",
    );
  }
}
