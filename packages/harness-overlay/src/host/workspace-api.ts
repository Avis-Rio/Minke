import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { MINKE_HOST_PROTOCOL_VERSION, type MinkeHostCapabilities } from "../minke-host-contract.ts";
import {
  parseFileManagerDiffRequest,
  parseFileManagerListRequest,
  parseFileManagerPreviewRequest,
  parseFileManagerWriteRequest,
} from "../tabs/files-contract.ts";
import { FileManagerRuntime } from "./file-manager.ts";

/** Portable Files capabilities on DSH's authenticated, shared Remote API. */
export class MinkeWorkspace extends TypertRemoteService {
  static inject = ["typert"];
  private readonly files: FileManagerRuntime;
  private readonly rootPath: string;

  constructor(ctx: Context, config: { rootPath: string }) {
    super(ctx, "minkeWorkspace", { namespace: "minke" });
    this.rootPath = config.rootPath;
    this.files = new FileManagerRuntime({
      rootPath: config.rootPath,
    });
  }

  @Remote
  capabilities(): MinkeHostCapabilities {
    return {
      protocolVersion: MINKE_HOST_PROTOCOL_VERSION,
      files: { available: true, root: this.rootPath, watch: false, write: true },
      tabs: { available: true, embeddedWeb: false, state: "client" },
    };
  }

  @Remote("files.diff")
  diff(request: unknown, signal: AbortSignal) {
    return this.execute(signal, () => this.files.diff(parseFileManagerDiffRequest(request)));
  }

  @Remote("files.list")
  list(request: unknown, signal: AbortSignal) {
    return this.execute(signal, () => this.files.list(parseFileManagerListRequest(request)));
  }

  @Remote("files.preview")
  preview(request: unknown, signal: AbortSignal) {
    return this.execute(signal, () => this.files.preview(parseFileManagerPreviewRequest(request)));
  }

  @Remote("files.write")
  write(request: unknown, signal: AbortSignal) {
    return this.execute(signal, () => this.files.write(parseFileManagerWriteRequest(request)));
  }

  private async execute<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TypeError) {
        throw new RemoteError("gateway/bad-request", error.message, {});
      }
      throw error;
    }
  }
}
