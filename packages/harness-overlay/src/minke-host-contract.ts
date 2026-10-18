/** Transport-neutral contract shared by the Minke Host and browser adapter. */
import type {
  FileManagerDiffRequest,
  FileManagerDiffResult,
  FileManagerListRequest,
  FileManagerListResult,
  FileManagerPreviewRequest,
  FileManagerPreviewResult,
  FileManagerWriteRequest,
  FileManagerWriteResult,
} from "./tabs/files-contract.ts";

export const MINKE_HOST_RPC_CHANNEL = "/api";
export const minkeHostEndpoint = (endpoint: MinkeHostRpcEndpoint): string => `minke/${endpoint}`;
export const MINKE_HOST_PROTOCOL_VERSION = 5;

export interface MinkeHostCapabilities {
  readonly protocolVersion: typeof MINKE_HOST_PROTOCOL_VERSION;
  readonly files: {
    readonly available: true;
    readonly root: string;
    readonly watch: false;
    readonly write: true;
  };
  readonly tabs: {
    readonly available: true;
    readonly embeddedWeb: false;
    readonly state: "client";
  };
}

/** One source of truth for every Host request and successful response. */
export type MinkeHostRpcMap = {
  readonly capabilities: {
    readonly request: Record<string, never>;
    readonly response: MinkeHostCapabilities;
  };
  readonly "files.diff": {
    readonly request: FileManagerDiffRequest;
    readonly response: FileManagerDiffResult;
  };
  readonly "files.list": {
    readonly request: FileManagerListRequest;
    readonly response: FileManagerListResult;
  };
  readonly "files.preview": {
    readonly request: FileManagerPreviewRequest;
    readonly response: FileManagerPreviewResult;
  };
  readonly "files.write": {
    readonly request: FileManagerWriteRequest;
    readonly response: FileManagerWriteResult;
  };
}

export type MinkeHostRpcEndpoint = keyof MinkeHostRpcMap;
export type MinkeHostRpcRequest<
  Endpoint extends MinkeHostRpcEndpoint,
> = MinkeHostRpcMap[Endpoint]["request"];
export type MinkeHostRpcResponse<
  Endpoint extends MinkeHostRpcEndpoint,
> = MinkeHostRpcMap[Endpoint]["response"];

function record(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Validate the capability handshake before a browser trusts the Host shape. */
export function parseMinkeHostCapabilities(
  value: unknown,
): MinkeHostCapabilities {
  const candidate = record(value, "Minke Host capabilities");
  const files = record(
    candidate.files,
    "Minke Host Files capabilities",
  );
  const tabs = record(
    candidate.tabs,
    "Minke Host Tabs capabilities",
  );
  if (
    candidate.protocolVersion !== MINKE_HOST_PROTOCOL_VERSION ||
    files.available !== true ||
    typeof files.root !== "string" ||
    files.root.length === 0 ||
    files.watch !== false ||
    files.write !== true ||
    tabs.available !== true ||
    tabs.embeddedWeb !== false ||
    tabs.state !== "client"
  ) {
    throw new TypeError("Minke Host capabilities are incompatible");
  }
  return {
    protocolVersion: MINKE_HOST_PROTOCOL_VERSION,
    files: {
      available: true,
      root: files.root,
      watch: false,
      write: true,
    },
    tabs: {
      available: true,
      embeddedWeb: false,
      state: "client",
    },
  };
}
