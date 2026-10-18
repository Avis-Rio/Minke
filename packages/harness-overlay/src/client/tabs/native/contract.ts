import type { ComponentType } from "react";

/** Private bridge to the pinned sidebar-tab-lifecycle runtime patch. */
export interface NativeTabRecord {
  readonly id: string;
  readonly kind: string;
  readonly contentId: string;
  readonly title: string;
}

export interface NativeTabSurface {
  readonly sessionId: string;
  readonly expanded: boolean;
  readonly activeId: string | undefined;
  readonly tabs: readonly NativeTabRecord[];
}

export interface NativeTabsConnection {
  read(): { surfaces: readonly NativeTabSurface[] };
  open(sessionId: string, tab: { kind: string; contentId: string; title: string; replaceTab?: string }, activate: boolean): void;
  focus(sessionId: string, tabId: string): void;
  place(sessionId: string, tabId: string, targetId: string, edge: "before" | "after"): void;
  close(contentId: string): void;
  setExpanded(sessionId: string, expanded: boolean): void;
  dispose(): void;
}

export interface NativeSidebarService {
  /** Public DSH signal for the session actually mounted in the sidebar. */
  readonly mounted: {
    getSnapshot(): string | undefined;
    subscribe(listener: () => void): () => void;
  };
  openTab(kind: string, options?: { paneId?: string }): string | undefined;
  connectMinkeTabs(options: {
    changed(): void;
    beforeClose(tab: NativeTabRecord): boolean;
  }): NativeTabsConnection;
}

export interface NativeTabInfo {
  readonly tab: NativeTabRecord & {
    readonly visible: boolean;
    readonly actions: {
      openTab(kind: string, options?: { replaceTab?: boolean }): void;
    };
  };
}

export interface NativeGuideEntry {
  readonly id: string;
  readonly providerId: string;
  readonly kind: string;
  readonly order: number;
  readonly title: () => string;
  readonly description?: () => string;
  readonly icon?: ComponentType<{ size?: number }>;
}

/** Public DSH registry surface used to retain other plugins' guide entries. */
export interface NativeTabRegistry {
  register(definition: { id: string; kind: string; title(): string; guide?: readonly Omit<NativeGuideEntry, "kind" | "providerId">[] }): () => void;
}

export const NATIVE_TAB_PREFIX = "dsh-resource://minke-tab/";
export const nativeContentId = (id: string): string => NATIVE_TAB_PREFIX + encodeURIComponent(id);
export const minkeTabId = (address: string): string | undefined => {
  if (!address.startsWith(NATIVE_TAB_PREFIX)) return undefined;
  try { return decodeURIComponent(address.slice(NATIVE_TAB_PREFIX.length)); }
  catch { return undefined; }
};
