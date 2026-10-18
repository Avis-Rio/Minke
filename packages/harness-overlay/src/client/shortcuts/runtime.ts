import {
  SHARED_SHORTCUT_COMMANDS, legacyShortcutBinding, shortcutCommandId, shortcutHint,
  type HarnessShortcuts,
} from "../../shared-shortcuts-contract.ts";
import type { ShortcutPlatform } from "./binding.ts";

export type PaletteActionGroup =
  | "session"
  | "open"
  | "view"
  | "application";

export interface PaletteActionMetadata {
  group: PaletteActionGroup;
  order?: number;
  keywords?: () => readonly string[];
  disabledReason?: () => string | undefined;
}

export interface ShortcutAction {
  id: string;
  label: () => string;
  defaultBinding: string | null;
  order?: number;
  palette?: PaletteActionMetadata;
  shortcutConfigurable?: boolean;
  run: () => void;
}

export interface ShortcutActionView {
  id: string;
  label: string;
  defaultBinding: string | null;
  binding: string | null;
  overridden: boolean;
  editable: boolean;
  order: number;
  conflicts: readonly string[];
}

export interface ShortcutRuntimeSnapshot {
  revision: number;
}

export interface PaletteActionView {
  id: string;
  label: string;
  group: PaletteActionGroup;
  keywords: readonly string[];
  binding: string | null;
  order: number;
  disabledReason: string | undefined;
}

/** Product actions and palette metadata; DSH owns dispatch, editing and persistence. */
export class ShortcutRuntime {
  readonly platform: ShortcutPlatform;
  readonly #shortcuts: HarnessShortcuts;
  #actions = new Map<string, ShortcutAction>();
  #disposers = new Map<string, () => void>();
  #listeners = new Set<() => void>();
  #beforeInvokeListeners = new Set<(id: string) => void>();
  #snapshot: ShortcutRuntimeSnapshot = { revision: 0 };
  readonly #unsubscribe: () => void;

  constructor(shortcuts: HarnessShortcuts) {
    this.#shortcuts = shortcuts;
    this.platform = shortcuts.platform === "macos" ? "apple" : "other";
    this.#unsubscribe = shortcuts.catalog.subscribe(() => this.#publish());
  }

  getSnapshot(): ShortcutRuntimeSnapshot { return this.#snapshot; }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  onBeforeInvoke(listener: (id: string) => void): () => void {
    this.#beforeInvokeListeners.add(listener);
    return () => { this.#beforeInvokeListeners.delete(listener); };
  }
  register(action: ShortcutAction): () => void {
    if (this.#actions.has(action.id)) throw new Error(`Duplicate action: ${action.id}`);
    let off = () => {};
    if (action.shortcutConfigurable !== false && !Object.hasOwn(SHARED_SHORTCUT_COMMANDS, action.id)) {
      // New installs inherit DSH's shared defaults; migration retains previous user bindings.
      const value = action.id === "palette.open" ? "Mod+Shift+K"
        : action.id === "tabs.bottom.toggle" ? "Mod+J" : action.defaultBinding;
      const binding = legacyShortcutBinding(value);
      // Keep browser defaults within DSH's supported Windows/macOS combinations.
      // Simple product bindings remain desktop-only; DSH owns validation and editing.
      const webDefaults = binding?.modifiers.some(modifier => modifier === "alt" || modifier === "shift")
        ? { "web:macos": binding, "web:windows": binding } : {};
      off = this.#shortcuts.register({
        id: shortcutCommandId(action.id), label: action.label, aliases: [],
        defaults: binding === null ? {} : {
          "desktop:macos": binding, "desktop:windows": binding, "desktop:linux": binding,
          ...webDefaults,
        },
        regions: ["page", "editable", "terminal"], modals: [],
        resolve: () => {
          const reason = action.palette?.disabledReason?.();
          return reason === undefined ? { status: "handled", run: () => { this.invoke(action.id); } }
            : { status: "blocked", reason };
        },
      });
    }
    this.#actions.set(action.id, action);
    this.#disposers.set(action.id, off);
    this.#publish();
    return () => {
      if (!this.#actions.delete(action.id)) return;
      this.#disposers.delete(action.id);
      off();
      this.#publish();
    };
  }
  invoke(id: string): boolean {
    const action = this.#actions.get(id);
    if (action === undefined || action.palette?.disabledReason?.() !== undefined) return false;
    for (const listener of this.#beforeInvokeListeners) listener(id);
    action.run();
    return true;
  }
  listActions(): readonly ShortcutActionView[] {
    const rows = new Map(this.#shortcuts.catalog.getSnapshot().map(row => [row.id as string, row]));
    return [...this.#actions.values()].filter(action => action.shortcutConfigurable !== false).map(action => {
      const row = rows.get(shortcutCommandId(action.id));
      return {
        id: action.id, label: action.label(), defaultBinding: action.defaultBinding,
        binding: row === undefined || row.issue !== null ? null : shortcutHint(row.binding, this.platform === "apple"),
        overridden: row?.modified ?? false, editable: false, order: action.order ?? 0,
        conflicts: row?.conflicts ?? [],
      };
    });
  }
  listPaletteActions(): readonly PaletteActionView[] {
    const bindings = new Map(this.listActions().map(row => [row.id, row.conflicts.length ? null : row.binding]));
    return [...this.#actions.values()].flatMap(action => {
      const metadata = action.palette;
      return metadata === undefined ? [] : [{
        id: action.id, label: action.label(), group: metadata.group,
        keywords: metadata.keywords?.() ?? [], binding: bindings.get(action.id) ?? null,
        order: metadata.order ?? action.order ?? 0, disabledReason: metadata.disabledReason?.(),
      }];
    }).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
  }
  dispose(): void {
    this.#unsubscribe();
    for (const off of this.#disposers.values()) off();
    this.#disposers.clear();
    this.#actions.clear();
    this.#listeners.clear();
    this.#beforeInvokeListeners.clear();
  }
  #publish(): void {
    this.#snapshot = { revision: this.#snapshot.revision + 1 };
    for (const listener of this.#listeners) listener();
  }
}
