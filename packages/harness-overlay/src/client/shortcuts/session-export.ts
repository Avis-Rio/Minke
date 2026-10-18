import type { HarnessClientContext } from "../core/context.ts";
import { mainSessionId } from "../core/sessions.ts";
import type { PaletteTranslate } from "../palette/locales.ts";
import type { ShortcutRuntime } from "./runtime.ts";

/** Public service provided by @deepseek-ai/dsh-session-log-export/client. */
interface SessionLogDownload {
  download(sessionId: string): Promise<void>;
}

/** Share the Header and /export controller, including its tracked service lifetime. */
export function installSessionExport(
  ctx: HarnessClientContext,
  runtime: ShortcutRuntime,
  t: PaletteTranslate,
): void {
  ctx.inject?.(["sessionLogDownload"], (scope) => {
    const download = scope.get("sessionLogDownload") as SessionLogDownload;
    scope.effect(() => runtime.register({
      id: "session.export",
      label: () => t("action.exportSession"),
      defaultBinding: null,
      shortcutConfigurable: false,
      palette: {
        group: "session",
        order: 40,
        keywords: () => [t("keywords.exportSession")],
        disabledReason: () => mainSessionId(ctx.sessions.list.getSnapshot()) === undefined
          ? t("disabled.activeSession") : undefined,
      },
      run: () => {
        const sessionId = mainSessionId(ctx.sessions.list.getSnapshot());
        if (sessionId === undefined) return;
        void download.download(sessionId).catch((error: unknown) => {
          console.warn("Minke could not export the current Session", error);
        });
      },
    }), "minke-overlay: native Session export palette action");
  });
}
