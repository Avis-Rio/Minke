import {
  MINKE_HOST_RPC_CHANNEL,
  minkeHostEndpoint,
  parseMinkeHostCapabilities,
  type MinkeHostRpcEndpoint,
  type MinkeHostRpcRequest,
  type MinkeHostRpcResponse,
} from "@minke/harness-overlay/minke-host-contract.ts";
import {
  parseTabsLayoutState,
  parseTabsLayoutStateUpdate,
  type TabsLayoutState,
} from "@minke/harness-overlay/tabs/contract.ts";
import {
  parseFileManagerDiffRequest,
  parseFileManagerDiffResult,
  parseFileManagerListRequest,
  parseFileManagerListResult,
  parseFileManagerPreviewRequest,
  parseFileManagerPreviewResult,
  parseFileManagerViewState,
  parseFileManagerViewStateUpdate,
  parseFileManagerWriteRequest,
  parseFileManagerWriteResult,
  type FileManagerViewState,
} from "@minke/harness-overlay/tabs/files-contract.ts";
import {
  desktopFilesPort,
  desktopTabsPort,
  type DesktopFilesPort,
  type DesktopTabsPort,
} from "../desktop/index.ts";
import type {
  HarnessClientContext,
  HarnessRpcResult,
} from "../core/context.ts";

const TABS_LAYOUT_STORAGE_KEY = "minke.host.tabs-layout.v1";
const FILES_VIEW_STORAGE_KEY = "minke.host.files-view.v1";

interface BrowserStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type Connection = HarnessClientContext["connection"];
type HostCaller = <Endpoint extends MinkeHostRpcEndpoint>(
  endpoint: Endpoint,
  payload: MinkeHostRpcRequest<Endpoint>,
  signal?: AbortSignal,
) => Promise<MinkeHostRpcResponse<Endpoint>>;

function browserStorage(): BrowserStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function rpcValue(result: HarnessRpcResult, endpoint: string): unknown {
  if (result.ok) return result.value;
  throw new Error(
    `Minke Host ${endpoint} failed (${result.error.code}): ` +
      result.error.message,
  );
}

function readStored<State>(
  storage: BrowserStorage | undefined,
  key: string,
  parse: (value: unknown) => State,
  fallback: State,
): State {
  if (storage === undefined) return fallback;
  try {
    const value = storage.getItem(key);
    return value === null ? fallback : parse(JSON.parse(value));
  } catch {
    return fallback;
  }
}

function writeStored(
  storage: BrowserStorage | undefined,
  key: string,
  value: unknown,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser state remains best-effort in private/locked-down contexts.
  }
}

function createHostCaller(connection: Connection): HostCaller {
  let ready:
    | ReturnType<typeof parseMinkeHostCapabilities>
    | Promise<ReturnType<typeof parseMinkeHostCapabilities>>
    | undefined;
  const ensureReady = () => {
    ready ??= connection.rpc
      .call(MINKE_HOST_RPC_CHANNEL, minkeHostEndpoint("capabilities"), { args: {} })
      .then((result) =>
        parseMinkeHostCapabilities(
          rpcValue(result, "capabilities"),
        ))
      .catch((error: unknown) => {
        // Share an in-flight handshake, but let a later caller retry after
        // connectivity recovers. Never retry the caller's actual operation.
        ready = undefined;
        throw error;
      });
    return Promise.resolve(ready);
  };
  return async <Endpoint extends MinkeHostRpcEndpoint>(
    endpoint: Endpoint,
    payload: MinkeHostRpcRequest<Endpoint>,
    signal?: AbortSignal,
  ): Promise<MinkeHostRpcResponse<Endpoint>> => {
    await ensureReady();
    return rpcValue(
      await connection.rpc.call(
        MINKE_HOST_RPC_CHANNEL,
        minkeHostEndpoint(endpoint),
        { args: { request: payload } },
        signal,
      ),
      endpoint,
    ) as MinkeHostRpcResponse<Endpoint>;
  };
}

/** Client-owned Tabs state for a normal browser projection. */
export function browserTabsPort(
  storage: BrowserStorage | undefined = browserStorage(),
): DesktopTabsPort {
  let state = readStored(
    storage,
    TABS_LAYOUT_STORAGE_KEY,
    parseTabsLayoutState,
    {},
  );
  return {
    available: true,
    embeddedWebAvailable: false,
    async readLayoutState() {
      return { ...state };
    },
    async writeLayoutState(value) {
      const update = parseTabsLayoutStateUpdate(value);
      state =
        update.placement === "right"
          ? { ...state, rightWidth: update.size }
          : { ...state, bottomHeight: update.size };
      writeStored(storage, TABS_LAYOUT_STORAGE_KEY, state);
    },
    openExternal(url) {
      globalThis.open?.(url, "_blank", "noopener,noreferrer");
    },
  };
}

/** Host RPC adapter for portable Files capabilities in a normal browser. */
export function browserFilesPort(
  connection: Connection,
  storage: BrowserStorage | undefined = browserStorage(),
): DesktopFilesPort {
  const call = createHostCaller(connection);
  let viewState: FileManagerViewState = readStored(
    storage,
    FILES_VIEW_STORAGE_KEY,
    parseFileManagerViewState,
    {},
  );
  return {
    available: true,
    watchAvailable: false,
    async diff(request) {
      return parseFileManagerDiffResult(
        await call(
          "files.diff",
          parseFileManagerDiffRequest(request),
        ),
      );
    },
    async list(request) {
      return parseFileManagerListResult(
        await call(
          "files.list",
          parseFileManagerListRequest(request),
        ),
      );
    },
    async preview(request) {
      return parseFileManagerPreviewResult(
        await call(
          "files.preview",
          parseFileManagerPreviewRequest(request),
        ),
      );
    },
    async write(request) {
      return parseFileManagerWriteResult(
        await call(
          "files.write",
          parseFileManagerWriteRequest(request),
        ),
      );
    },
    async readViewState() {
      return parseFileManagerViewState(viewState);
    },
    async writeViewState(value) {
      const update = parseFileManagerViewStateUpdate(value);
      viewState =
        "codeTheme" in update
          ? {
              ...viewState,
              codeThemes: {
                ...viewState.codeThemes,
                [update.colorScheme]: update.codeTheme,
              },
            }
          : {
              ...viewState,
              [update.placement]: {
                ...viewState[update.placement],
                ...(update.explorerPosition === undefined
                  ? {}
                  : {
                      explorerPosition:
                        update.explorerPosition,
                    }),
                ...(update.previewWidth === undefined
                  ? {}
                  : { previewWidth: update.previewWidth }),
                ...(update.viewMode === undefined
                  ? {}
                  : { viewMode: update.viewMode }),
              },
            };
      writeStored(storage, FILES_VIEW_STORAGE_KEY, viewState);
    },
    watch() {
      return () => {};
    },
  };
}

/** Prefer native preload capabilities and fall back to Minke Host. */
export function minkeWorkspacePorts(
  connection: Connection,
  desktopTabs: DesktopTabsPort = desktopTabsPort(),
  desktopFiles: DesktopFilesPort = desktopFilesPort(),
): {
  readonly files: DesktopFilesPort;
  readonly tabs: DesktopTabsPort;
} {
  return {
    files: desktopFiles.available
      ? desktopFiles
      : browserFilesPort(connection),
    tabs: desktopTabs.available
      ? desktopTabs
      : browserTabsPort(),
  };
}

export type {
  BrowserStorage,
  TabsLayoutState,
};
