/** Present effective DSH shortcut bindings in Minke palette and tab hints. */

export type ShortcutPlatform = "apple" | "other";

const KEY_LABELS: Readonly<Record<string, string>> = {
  Space: "Space",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  PageUp: "PgUp",
  PageDown: "PgDn",
};
const APPLE_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  Mod: "⌘",
  Ctrl: "⌃",
  Meta: "⌘",
  Alt: "⌥",
  Shift: "⇧",
};
const APPLE_MODIFIER_ORDER: Readonly<Record<string, number>> = {
  Ctrl: 0,
  Alt: 1,
  Shift: 2,
  Mod: 3,
  Meta: 3,
};
const OTHER_MODIFIER_LABELS: Readonly<Record<string, string>> = {
  Mod: "Ctrl",
  Ctrl: "Ctrl",
  Meta: "Meta",
  Alt: "Alt",
  Shift: "Shift",
};
const ARIA_KEY_LABELS: Readonly<Record<string, string>> = {
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
};

/** Detect the browser platform used for logical Mod semantics. */
export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === "undefined") return "other";
  const modern = (
    navigator as Navigator & {
      userAgentData?: { platform?: string };
    }
  ).userAgentData?.platform;
  const platform = modern ?? navigator.platform;
  return /Mac|iPhone|iPad|iPod/iu.test(platform) ? "apple" : "other";
}

/** Split a canonical shortcut into platform-native keys for visual keycaps. */
export function formatShortcutBindingParts(
  binding: string,
  platform: ShortcutPlatform,
): readonly string[] {
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const labels = platform === "apple"
    ? APPLE_MODIFIER_LABELS
    : OTHER_MODIFIER_LABELS;
  const modifiers = platform === "apple"
    ? [...parts].sort(
        (left, right) =>
          (APPLE_MODIFIER_ORDER[left] ?? Number.MAX_SAFE_INTEGER) -
          (APPLE_MODIFIER_ORDER[right] ?? Number.MAX_SAFE_INTEGER),
      )
    : parts;
  return [
    ...modifiers.map((part) => labels[part] ?? part),
    KEY_LABELS[key] ?? key,
  ];
}

/** Format a canonical shortcut for compact text and assistive output. */
export function formatShortcutBinding(
  binding: string,
  platform: ShortcutPlatform,
): string {
  const parts = formatShortcutBindingParts(binding, platform);
  return parts.join(platform === "apple" ? "" : " + ");
}

/** Format a canonical binding using valid aria-keyshortcuts key names. */
export function formatShortcutBindingAria(
  binding: string,
  platform: ShortcutPlatform,
): string | undefined {
  if (binding.split("+").filter(part => !["Mod", "Ctrl", "Meta", "Alt", "Shift"].includes(part)).length > 1) return undefined;
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  return [
    ...parts.map((part) => {
      if (part === "Mod") {
        return platform === "apple" ? "Meta" : "Control";
      }
      return part === "Ctrl" ? "Control" : part;
    }),
    ARIA_KEY_LABELS[key] ?? key,
  ].join("+");
}
