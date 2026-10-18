import type { HarnessClientContext, HarnessRemoteResult } from "../core/context.ts";

/** Public Session Remote operations; the serving Host owns native path validation. */
export interface WorkspacePathRemote {
  canOpenWorkspacePath(): Promise<HarnessRemoteResult>;
  openWorkspacePath(request: { path: string }, signal?: AbortSignal): Promise<HarnessRemoteResult>;
}

export interface WorkspacePathActions {
  getSnapshot(): boolean;
  subscribe(listener: () => void): () => void;
  open(path: string): Promise<void>;
}

export const unavailableWorkspacePaths: WorkspacePathActions = {
  getSnapshot: () => false,
  subscribe: () => () => {},
  async open() { throw new Error("The Host cannot open paths with a native application"); },
};

/** One capability observation shared by all Files views, independent of their data transport. */
export class HostWorkspacePaths implements WorkspacePathActions {
  readonly #listeners = new Set<() => void>();
  #binding: { remote: WorkspacePathRemote; lifetime: AbortController } | undefined;
  #available = false;

  readonly getSnapshot = (): boolean => this.#available;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  connect(remote: WorkspacePathRemote): () => void {
    this.#binding?.lifetime.abort();
    const binding = { remote, lifetime: new AbortController() };
    this.#binding = binding;
    this.#publish(false);
    void remote.canOpenWorkspacePath().then(result => {
      if (this.#binding === binding) this.#publish(result.ok && result.value === true);
    }, () => {
      if (this.#binding === binding) this.#publish(false);
    });
    return () => {
      binding.lifetime.abort();
      if (this.#binding !== binding) return;
      this.#binding = undefined;
      this.#publish(false);
    };
  }

  async open(path: string): Promise<void> {
    const binding = this.#binding;
    if (binding === undefined || !this.#available) return unavailableWorkspacePaths.open(path);
    const result = await binding.remote.openWorkspacePath({ path }, binding.lifetime.signal);
    binding.lifetime.signal.throwIfAborted();
    if (!result.ok) throw result.error;
  }

  #publish(available: boolean): void {
    if (available === this.#available) return;
    this.#available = available;
    for (const listener of this.#listeners) listener();
  }
}

export function installWorkspacePathActions(ctx: HarnessClientContext): WorkspacePathActions {
  const paths = new HostWorkspacePaths();
  ctx.inject?.(["remote.session"], scope => {
    const remote = scope.get("remote") as { session: WorkspacePathRemote };
    scope.effect(() => paths.connect(remote.session), "minke-overlay: native Host path actions");
  });
  return paths;
}
