import type { Shortcuts } from "@deepseek-ai/dsh-client-shortcuts/client";
import type { NormalizedBinding, ShortcutBinding, ShortcutCommandId } from "@deepseek-ai/dsh-client-shortcuts/protocol";

export type HarnessShortcuts = Shortcuts;
export const SHORTCUT_IPC = Object.freeze({
  get: "minke:shortcuts:get", edit: "minke:shortcuts:edit",
  changed: "minke:shortcuts:changed", recording: "minke:shortcuts:recording",
  accepted: "minke:shortcuts:accepted",
  input: "minke:shortcuts:input", close: "minke:shortcuts:close",
});

/** Existing DSH owners also serve Minke's menu and palette entries. */
export const SHARED_SHORTCUT_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  "settings.open": "settings.open", "session.new": "session.new",
  "sidebar.toggle": "sidebar.left.toggle", "tabs.toggle": "sidebar.right.toggle",
});

export function shortcutCommandId(id: string): ShortcutCommandId {
  return (SHARED_SHORTCUT_COMMANDS[id] ?? `minke.${id}`) as ShortcutCommandId;
}

/** Translate the old configuration once; physical-key validation remains DSH-owned. */
export function legacyShortcutBinding(value: string | null): ShortcutBinding | null {
  if (!value) return null;
  const tokens = value.split("+");
  const key = tokens.pop()!;
  const modifiers = { Mod: "primary", Ctrl: "control", Meta: "meta", Alt: "alt", Shift: "shift" } as const;
  return { code: /^[A-Z]$/u.test(key) ? `Key${key}` : /^\d$/u.test(key) ? `Digit${key}` : key,
    modifiers: tokens.map(token => modifiers[token as keyof typeof modifiers]) };
}

/** Palette and tab hints use the accepted catalog, including two-key chords. */
export function shortcutHint(binding: NormalizedBinding | null, apple: boolean): string | null {
  if (binding === null) return null;
  const primary = apple ? "meta" : "control";
  const names = { control: "Ctrl", meta: "Meta", alt: "Alt", shift: "Shift" };
  const order = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
  return [...binding.modifiers.map(value => value === primary ? "Mod" : names[value])
    .sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    binding.code.replace(/^(Key|Digit)/u, ""),
    ...(binding.secondCode === undefined ? [] : [binding.secondCode.replace(/^(Key|Digit)/u, "")])].join("+");
}
