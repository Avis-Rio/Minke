import type { TabRendererRegistry } from "../registry.ts";
import type { TabsRuntime } from "../runtime.ts";
import type { ManagedTab, TabsLayoutDelegate } from "../types.ts";
import {
  minkeTabId,
  nativeContentId,
  type NativeSidebarService,
  type NativeTabsConnection,
  type NativeTabSurface,
} from "./contract.ts";

type PendingIntent =
  | { type: "native"; kind: string }
  | { type: "focus"; id: string }
  | { type: "visible"; visible: boolean };

/** Joins Minke content instances to DSH's authoritative, per-session layouts. */
export class NativeTabsRuntime implements TabsLayoutDelegate {
  readonly #tabs: TabsRuntime;
  readonly #renderers: TabRendererRegistry;
  readonly #activateConversation: (() => void) | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #viewports = new Map<string, Set<HTMLElement>>();
  #connection: NativeTabsConnection | undefined;
  #sidebar: NativeSidebarService | undefined;
  #sessionId: string | undefined;
  #surfaces = new Map<string, NativeTabSurface>();
  #revision = 0;
  #syncing = false;
  #createTarget: { replaceTab: string } | undefined;
  #pending: PendingIntent[] = [];
  #activationRequested = false;

  constructor(tabs: TabsRuntime, renderers: TabRendererRegistry, activateConversation?: () => void) {
    this.#tabs = tabs;
    this.#renderers = renderers;
    this.#activateConversation = activateConversation;
  }

  readonly getSnapshot = (): number => this.#revision;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  get connected(): boolean { return this.#connection !== undefined; }
  get active(): boolean {
    return this.#sessionId !== undefined && this.#sidebar?.mounted.getSnapshot() === this.#sessionId;
  }
  get sessionId(): string | undefined { return this.#sessionId; }

  openNative(kind: string): string | undefined {
    if (!this.#connection) return undefined;
    this.#sync();
    if (this.active) return this.#sidebar?.openTab(kind);
    this.#pending.push({ type: "native", kind });
    this.#requestActivation();
    return undefined;
  }

  connect(sidebar: NativeSidebarService): () => void {
    const connection = sidebar.connectMinkeTabs({
      changed: () => this.#sync(),
      beforeClose: (record) => {
        const id = minkeTabId(record.contentId);
        const tab = id === undefined ? undefined : this.#tabs.tab(id);
        return tab === undefined || this.#renderers.get(tab.kind)?.beforeClose?.(tab) !== false;
      },
    });
    this.#connection = connection;
    this.#sidebar = sidebar;
    const releaseMounted = sidebar.mounted.subscribe(() => {
      // Finish the native seat transition before projecting its layout.
      queueMicrotask(() => { if (this.#connection === connection) this.#sync(); });
    });
    const releaseLayout = this.#tabs.connectLayout(this);
    this.#sync();
    this.#emit();
    return () => {
      if (this.#connection !== connection) return;
      this.#pending = [];
      this.#activationRequested = false;
      // Extension unload/HMR must not leave records that can later alias a
      // newly minted Minke instance with the same local id.
      for (const tab of this.#tabs.getSnapshot().tabs) connection.close(nativeContentId(tab.id));
      releaseMounted();
      releaseLayout();
      connection.dispose();
      this.#connection = undefined;
      this.#sidebar = undefined;
      this.#sessionId = undefined;
      this.#surfaces.clear();
      this.#emit();
    };
  }

  open(tab: ManagedTab, activate: boolean): boolean {
    const connection = this.#connection;
    const sessionId = this.#sessionId;
    if (!connection) return false;
    if (!this.active || !sessionId) {
      // Background hydration/opening only supplies content. Foreground intent
      // waits for DSH's Conversation seat instead of reviving a second shell.
      if (activate) {
        this.#pending.push({ type: "focus", id: tab.id }, { type: "visible", visible: true });
        this.#requestActivation();
      }
      return true;
    }
    connection.open(sessionId, {
      kind: `minke.${tab.kind}`,
      contentId: nativeContentId(tab.id),
      title: tab.title,
      ...this.#createTarget,
    }, activate || this.#surfaces.get(sessionId)?.activeId === undefined);
    connection.setExpanded(sessionId, true);
    this.#sync();
    return true;
  }

  /** A synchronous creator replaces the guide in its own pane and strip slot. */
  createAt(tabId: string, create: () => void): void {
    if (!this.#sessionId || !this.#surfaces.get(this.#sessionId)?.tabs.some(tab => tab.id === tabId)) return;
    const previous = this.#createTarget;
    this.#createTarget = { replaceTab: tabId };
    try { create(); }
    finally { this.#createTarget = previous; }
  }

  activate(id: string): boolean {
    if (!this.#connection) return false;
    if (!this.active) {
      this.#pending.push({ type: "focus", id });
      this.#requestActivation();
      return true;
    }
    const record = this.#record(id);
    if (!this.#sessionId || !this.#connection || !record) return false;
    this.#connection.focus(this.#sessionId, record.id);
    this.#sync();
    return true;
  }

  place(id: string, targetId: string, edge: "before" | "after"): boolean {
    if (!this.#connection) return false;
    if (!this.active || !this.#sessionId) return true;
    const tab = this.#record(id);
    const target = this.#record(targetId);
    if (tab && target) this.#connection.place(this.#sessionId, tab.id, target.id, edge);
    this.#sync();
    return true;
  }

  close(id: string): boolean {
    this.#connection?.close(nativeContentId(id));
    return this.connected;
  }

  setVisible(visible: boolean): boolean {
    if (!this.#connection) return false;
    if (!this.active || !this.#sessionId) {
      if (visible || this.#pending.length > 0) this.#pending.push({ type: "visible", visible });
      if (visible) this.#requestActivation();
      return true;
    }
    // Calling the native action with an unchanged value would still publish a store commit.
    if (this.#surfaces.get(this.#sessionId)?.expanded !== visible) {
      this.#connection.setExpanded(this.#sessionId, visible);
      this.#sync();
    }
    return true;
  }

  attachViewport(id: string, element: HTMLElement): () => void {
    const entries = this.#viewports.get(id) ?? new Set();
    entries.add(element);
    this.#viewports.set(id, entries);
    this.#emit();
    return () => {
      entries.delete(element);
      if (entries.size === 0) this.#viewports.delete(id);
      this.#emit();
    };
  }

  viewport(id: string): HTMLElement | undefined {
    return [...(this.#viewports.get(id) ?? [])].find(element =>
      element.isConnected && element.dataset.visible === "true");
  }

  #record(id: string) {
    return this.#sessionId === undefined ? undefined :
      this.#surfaces.get(this.#sessionId)?.tabs.find(tab => tab.contentId === nativeContentId(id));
  }

  #requestActivation(): void {
    if (this.#activationRequested) return;
    this.#activationRequested = true;
    this.#activateConversation?.();
  }

  #sync(): void {
    const connection = this.#connection;
    if (!connection || this.#syncing) return;
    this.#syncing = true;
    try {
      let snapshot = connection.read();
      const current = snapshot.surfaces.find(surface => surface.sessionId === this.#sidebar?.mounted.getSnapshot());
      const sessionId = current?.sessionId;
      const changedSession = this.#sessionId !== sessionId;
      const carry = this.#tabs.getSnapshot();

      // A committed close in any session removes the global content instance.
      // Unmounting a session seat or releasing a store is not a close.
      for (const surface of snapshot.surfaces) {
        const previous = this.#surfaces.get(surface.sessionId);
        for (const record of previous?.tabs ?? []) {
          const id = minkeTabId(record.contentId);
          if (id === undefined || !this.#tabs.tab(id)) continue;
          if (!surface.tabs.some(tab => tab.contentId === record.contentId)) this.#tabs.close(id);
        }
      }

      this.#sessionId = sessionId;
      if (sessionId) {
        // Global Minke content keeps its identity across sessions. Each session
        // owns its placement alongside that session's native document tabs.
        for (const tab of this.#tabs.getSnapshot().tabs) {
          if (current?.tabs.some(record => record.contentId === nativeContentId(tab.id))) continue;
          connection.open(sessionId, {
            kind: `minke.${tab.kind}`, contentId: nativeContentId(tab.id), title: tab.title,
          }, false);
        }
        if (changedSession && carry.visible && carry.activeId) {
          const surface = connection.read().surfaces.find(value => value.sessionId === sessionId);
          const tab = surface?.tabs.find(record => record.contentId === nativeContentId(carry.activeId!));
          if (tab) connection.focus(sessionId, tab.id);
        }
        this.#activationRequested = false;
        // Content is mapped first so a deferred focus can use the native id.
        // Preserve request order when native and custom opens were interleaved.
        for (const intent of this.#pending.splice(0)) {
          if (intent.type === "native") this.#sidebar?.openTab(intent.kind);
          else if (intent.type === "visible") connection.setExpanded(sessionId, intent.visible);
          else {
            const surface = connection.read().surfaces.find(value => value.sessionId === sessionId);
            const tab = surface?.tabs.find(record => record.contentId === nativeContentId(intent.id));
            if (tab) connection.focus(sessionId, tab.id);
          }
        }
      }
      snapshot = connection.read();
      // Undo must not resurrect a disposed PTY/WebView. Native document history
      // remains owned by DSH and is unaffected by this content-specific cleanup.
      for (const surface of snapshot.surfaces) {
        for (const record of surface.tabs) {
          const id = minkeTabId(record.contentId);
          if (id !== undefined && !this.#tabs.tab(id)) connection.close(record.contentId);
        }
      }
      snapshot = connection.read();
      this.#surfaces = new Map(snapshot.surfaces.map(surface => [surface.sessionId, surface]));
      const active = sessionId === undefined ? undefined : this.#surfaces.get(sessionId);
      if (active) {
        const record = active.tabs.find(tab => tab.id === active.activeId);
        this.#tabs.projectLayout(
          active.tabs.flatMap(tab => { const id = minkeTabId(tab.contentId); return id === undefined ? [] : [id]; }),
          record === undefined ? undefined : minkeTabId(record.contentId),
          active.expanded,
        );
      }
      if (changedSession) this.#emit();
    } finally { this.#syncing = false; }
  }

  #emit(): void {
    this.#revision += 1;
    for (const listener of this.#listeners) listener();
  }
}
