import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { MinkeWorkspace } from "./host/workspace-api.ts";
import {
  installMinkePwaHost,
  type PwaWebServer,
} from "./host/pwa.ts";
import {
  apply as installAgentBrowserTools,
} from "./host/agent-browser-tools.ts";
import {
  installAgentBrowserParentLifetime,
} from "./host/agent-browser-process.ts";
import {
  AGENT_BROWSER_IPC_VERSION_ENV,
  AGENT_BROWSER_PROTOCOL_VERSION,
} from "./agent-browser-contract.ts";
import {
  installAgentTurnControl,
  type AgentTurnSessionControllerPort,
} from "./host/agent-turn-control.ts";
import {
  RemotePreviewRuntime,
  type RemotePreviewWebServer,
} from "./host/remote-preview.ts";
import {
  installTrustedHostControl,
} from "./host/trusted-host-control.ts";
import {
  calibrateMinkeImIdentity,
  isMinkeImSessionId,
} from "./host/im-identity.ts";

export const name = "minke-host";
export const inject = [
  "agentPresets",
  "agents",
  "attachments",
  "connection",
  "sessionController",
  "systemPrompt",
  "tools",
  "webServer",
];

export interface Config {
  /** Absolute filesystem boundary exposed to remote Files tabs. */
  readonly rootPath?: string;
  /** Durable private storage for generated HTML preview snapshots. */
  readonly previewStorePath?: string;
}

interface MinkeHostAgent {
  readonly id: string;
  readonly status: "idle" | "running";
  cancel(cause: { readonly kind: "user" }): void;
  readonly session: {
    readonly id: string;
  };
  readonly ctx: {
    readonly systemPrompt: {
      section(section: {
        readonly name: string;
        readonly order: number;
        readonly text:
          | string
          | ((context: {
              readonly scope?: MinkeHostAgent;
            }) => string);
      }): () => void;
    };
    readonly tools: {
      restrict(filter: {
        readonly allow?: readonly string[];
        readonly deny?: readonly string[];
      }): () => void;
    };
  };
}

interface MinkeHostContext {
  get(name: "appExit"): ((code: number) => void) | undefined;
  effect(
    callback: () => void | (() => void | Promise<void>),
    label: string,
  ): unknown;
  readonly connection: {
    replaceTrustedHosts(
      trustedHosts: readonly string[],
    ): void;
  };
  plugin(service: typeof MinkeWorkspace, config: { rootPath: string }): unknown;
  readonly sessionController: AgentTurnSessionControllerPort;
  readonly agents: {
    get(sessionId: string): MinkeHostAgent | undefined;
  };
  readonly tools: {
    register(definition: {
      readonly name: string;
      readonly description: string;
      readonly parameters: Record<string, unknown>;
      readonly output: {
        readonly schema: Record<string, unknown>;
        render(
          args: unknown,
          value: unknown,
        ): readonly (
          | { readonly type: "text"; readonly text: string }
          | {
              readonly type: "image";
              readonly attachment: {
                readonly attachmentId: string;
                readonly mediaType: "image/png";
                readonly bytes: number;
                readonly width: number;
                readonly height: number;
              };
            }
        )[];
      };
      readonly timeoutMs: number;
      execute(
        args: unknown,
        exec: {
          readonly signal: AbortSignal;
          readonly agent?: {
            readonly session: { readonly id: string };
          };
        },
      ): Promise<unknown>;
      finalizeContent?(
        exec: Readonly<{
          readonly signal: AbortSignal;
          readonly agent?: {
            readonly session: { readonly id: string };
          };
        }>,
        result: Readonly<{
          readonly isError: boolean;
          readonly value?: unknown;
          readonly content: readonly unknown[];
        }>,
      ): readonly unknown[] | undefined;
      presentCall(args: unknown): unknown;
    }): unknown;
  };
  readonly attachments: {
    saveImage(input: {
      readonly data: Uint8Array;
      readonly mediaType: "image/png";
      readonly name?: string;
    }): Promise<{
      readonly attachmentId: string;
      readonly mediaType: "image/png";
      readonly bytes: number;
      readonly width: number;
      readonly height: number;
      readonly name?: string;
      readonly originalDimensions?: {
        readonly width: number;
        readonly height: number;
      };
    }>;
  };
  readonly agentPresets: {
    composedPreset(agentContext: unknown): string | undefined;
  };
  on(
    event: "agent/created" | "agent/disposed",
    listener: (payload: {
      readonly agent: MinkeHostAgent;
    }) => void,
  ): unknown;
  on(
    event: "agent-preset/selected",
    listener: (
      sessionId: string,
      agentPreset: string,
    ) => void,
  ): unknown;
  on(
    event: "agent/status",
    listener: (payload: {
      readonly agent: MinkeHostAgent;
      readonly status: "idle" | "running";
    }) => void,
  ): unknown;
  on(
    event: "agent/pre-step",
    listener: (
      payload: {
        readonly agent: MinkeHostAgent;
        readonly turn: number;
        readonly step: number;
        readonly signal: AbortSignal;
      },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): unknown;
  readonly webServer: PwaWebServer & RemotePreviewWebServer;
}

function configuredRoot(config: Config | undefined): string {
  const candidate = config?.rootPath?.trim();
  if (candidate === undefined || candidate === "") {
    return resolve(homedir());
  }
  if (!isAbsolute(candidate)) {
    throw new TypeError("Minke Host rootPath must be absolute");
  }
  return resolve(candidate);
}

function configuredPreviewStore(
  config: Config | undefined,
): string {
  const candidate = config?.previewStorePath?.trim();
  if (candidate === undefined || candidate === "") {
    return resolve(process.cwd(), "remote-previews");
  }
  if (!isAbsolute(candidate)) {
    throw new TypeError(
      "Minke Host previewStorePath must be absolute",
    );
  }
  return resolve(candidate);
}

/**
 * Mount portable Minke capabilities on DSH's trusted browser transport seam.
 * Files use this transport; terminals use DSH. Native Web views and OS path
 * opening remain behind Electron preload.
 */
export function apply(
  ctx: MinkeHostContext,
  config?: Config,
): void {
  const rootPath = configuredRoot(config);
  const previews = new RemotePreviewRuntime({
    rootPath,
    storePath: configuredPreviewStore(config),
    webServer: ctx.webServer,
  });
  ctx.effect(
    () => () => previews.dispose(),
    "minke-host: Remote HTML previews",
  );
  ctx.on("agent/created", ({ agent }) => {
    calibrateMinkeImIdentity(agent);
  });
  installAgentTurnControl(ctx, undefined, {
    previewPublisher: {
      async publish(input) {
        if (!isMinkeImSessionId(input.sessionId)) return [];
        return await previews.publish({
          operationId: input.operationId,
          paths: input.paths,
        });
      },
    },
  });
  installTrustedHostControl(ctx);
  const agentBrowserIpcVersion =
    process.env[AGENT_BROWSER_IPC_VERSION_ENV];
  if (agentBrowserIpcVersion !== undefined) {
    const expectedVersion = String(AGENT_BROWSER_PROTOCOL_VERSION);
    if (agentBrowserIpcVersion !== expectedVersion) {
      throw new Error(
        `Agent Browser IPC version mismatch: expected ${expectedVersion}, received ${agentBrowserIpcVersion}`,
      );
    }
    const exit = ctx.get("appExit");
    if (typeof exit !== "function") {
      throw new Error(
        "Agent Browser desktop mode requires the Harness appExit service",
      );
    }
    installAgentBrowserParentLifetime(ctx, exit);
    if (!installAgentBrowserTools(ctx)) {
      throw new Error(
        "Agent Browser desktop mode failed to install its IPC tools",
      );
    }
  }
  ctx.effect(
    () => installMinkePwaHost(ctx.webServer),
    "minke-host: PWA resources",
  );
  ctx.plugin(MinkeWorkspace, { rootPath });
}
