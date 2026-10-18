import type { DshTerminalUI } from "./dsh.ts";
import type { TerminalSettingsRuntime } from "./settings/runtime.ts";
import type { CodeThemeSettingsRuntime } from "../files/code-theme-runtime.ts";
import { loadTerminalCodeTheme, terminalCodeThemeFallback } from "../files/code-themes.ts";

/** DSH owns typography; publish only Minke's spacing and palette. */
export function connectTerminalAppearance(ui: DshTerminalUI, settings: TerminalSettingsRuntime, themes: CodeThemeSettingsRuntime): () => void {
  let generation = 0;
  const sync = (): void => {
    const current = ++generation;
    const theme = themes.getSnapshot().theme;
    ui.setAppearance({ lineHeight: settings.getSnapshot().settings.lineHeight, theme: terminalCodeThemeFallback(theme) });
    void loadTerminalCodeTheme(theme).then(palette => {
      if (current === generation) ui.setAppearance({ lineHeight: settings.getSnapshot().settings.lineHeight, theme: palette });
    }).catch(error => { console.warn("Unable to load Terminal palette", error); });
  };
  const releaseSettings = settings.subscribe(sync);
  const releaseThemes = themes.subscribe(sync);
  sync();
  return () => { generation++; releaseSettings(); releaseThemes(); ui.setAppearance({}); };
}
