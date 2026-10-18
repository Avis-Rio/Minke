import { execFile } from "node:child_process";
import {
  LOCAL_MODEL_RUNTIMES,
  type LocalModelRuntimeId,
  type ModelRuntimeServiceState,
} from "@lencx/minke-model-runtime/contract";
import { externalRuntimeEnvironment } from "@lencx/minke-model-runtime/process-environment";
import type { LocalModelCommands } from "./local-model-command.ts";

const STATUS_TIMEOUT_MS = 2_000;

interface StatusProbeDependencies {
  fetch?: typeof fetch;
  run?: (command: string, args: string[]) => Promise<string>;
  environment?: NodeJS.ProcessEnv;
}

function runStatusCommand(command: string, args: string[], environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: STATUS_TIMEOUT_MS,
      maxBuffer: 16 * 1024,
      windowsHide: true,
      encoding: "utf8",
      env: externalRuntimeEnvironment(environment),
    }, (error, stdout) => {
      if (error !== null) reject(error);
      else resolve(stdout);
    });
  });
}

function isConnectionRefused(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return Reflect.get(error, "code") === "ECONNREFUSED" ||
    isConnectionRefused(Reflect.get(error, "cause"));
}

/** Read actual local service state without starting services or loading models. */
export function createLocalModelStatusProbe(
  commands: LocalModelCommands,
  dependencies: StatusProbeDependencies = {},
): (id: LocalModelRuntimeId) => Promise<ModelRuntimeServiceState> {
  const request = dependencies.fetch ?? globalThis.fetch;
  const run = dependencies.run ?? ((command, args) => runStatusCommand(command, args, dependencies.environment ?? process.env));
  return async (id) => {
    // The CLI knows LM Studio's selected port, including non-default ports.
    if (id === "lmStudio" && commands.lmStudio !== undefined) {
      try {
        const status = JSON.parse(await run(commands.lmStudio, ["server", "status", "--json"]));
        if (typeof status?.running !== "boolean") return "unknown";
        return status.running ? "running" : "stopped";
      } catch {
        return "unknown";
      }
    }

    const descriptor = LOCAL_MODEL_RUNTIMES.find((entry) => entry.id === id)!;
    const endpoint = id === "ollama"
      ? new URL("/api/version", descriptor.defaultBaseURL).href
      : `${descriptor.defaultBaseURL}/models`;
    try {
      const response = await request(endpoint, {
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) return "unknown";
      const value = await response.json() as { version?: unknown; object?: unknown; data?: unknown } | null;
      if (id === "ollama") {
        return typeof value?.version === "string" && value.version.trim() !== ""
          ? "running"
          : "unknown";
      }
      return Array.isArray(value?.data) || (value?.object === "list" && value.data === null)
        ? "running"
        : "unknown";
    } catch (error) {
      return isConnectionRefused(error) ? "stopped" : "unknown";
    }
  };
}
