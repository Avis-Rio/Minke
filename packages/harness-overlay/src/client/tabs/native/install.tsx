import { mainSessionId } from "../../core/sessions.ts";
import type { ComponentType } from "react";
import type { HarnessClientContext } from "../../core/context.ts";
import type { TabCreateShortcutBindings } from "../create-shortcuts.ts";
import type { TabsLocaleKey } from "../locales.ts";
import type { TabRendererRegistry } from "../registry.ts";
import type { TabsRuntime } from "../runtime.ts";
import type { NativeSidebarService, NativeTabRegistry } from "./contract.ts";
import { LegacyNativeTabGuide, NativeTabGuide } from "./Guide.tsx";
import { minkeTabResourceProvider, type MinkeTabResources } from "./resources.ts";
import { NativeTabsRuntime } from "./runtime.ts";
import { NativeTabBody, NativeTabTitle } from "./views.tsx";

const TABS_NAMESPACE = "minke.tabs";

export function installNativeTabs(ctx: HarnessClientContext, runtime: TabsRuntime, renderers: TabRendererRegistry, createShortcuts: TabCreateShortcutBindings): NativeTabsRuntime {
  const native = new NativeTabsRuntime(runtime, renderers, () => {
    ctx.layout.selectPanel(null);
    if (mainSessionId(ctx.sessions.list.getSnapshot()) === undefined) ctx.uiWorkspace.startSession();
  });
  ctx.inject?.(["sidebarRight", "sidebarRightTabs", "resources"], scope => {
    const sidebar = scope.get("sidebarRight") as NativeSidebarService;
    const registry = scope.get("sidebarRightTabs") as NativeTabRegistry;
    scope.effect(() => {
      const resources = scope.get("resources") as MinkeTabResources;
      const releaseResources = resources.register(minkeTabResourceProvider(runtime));
      const registered = new Map<string, (() => void)[]>();
      const syncTypes = (): void => {
        for (const kind of renderers.kinds()) {
          if (renderers.get(kind)?.nativeKind) continue;
          if (registered.has(kind)) continue;
          const id = `@lencx/minke-harness-overlay/tab/${kind}`;
          registered.set(kind, [
            registry.register({ id, kind: `minke.${kind}`, title: () => kind }),
            ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
              name: "sidebar.right.pane.tab", key: id, inject: () => ({ native }),
            }, NativeTabBody as ComponentType<never>)),
            ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
              name: "sidebar.right.pane.tab.title", key: id, inject: () => ({ runtime, renderers }),
            }, NativeTabTitle as ComponentType<never>)),
          ]);
        }
        for (const [kind, releases] of registered) {
          if (renderers.get(kind)) continue;
          for (const release of releases.reverse()) release();
          registered.delete(kind);
        }
      };
      syncTypes();
      const releaseTypes = renderers.subscribe(syncTypes);
      const injectGuide = () => ({
        native, renderers, createShortcuts,
        currentCwd: () => {
          const sessions = ctx.sessions.list.getSnapshot();
          const sessionId = mainSessionId(sessions);
          return sessionId === undefined ? undefined : sessions.byId[sessionId]?.cwd;
        },
      });
      const guideId = "@lencx/minke-harness-overlay/tab/launcher";
      const t = ctx.locale.bind<TabsLocaleKey>(TABS_NAMESPACE);
      // Preserve earlier launcher addresses and contribute Minke's guide entry.
      // The native guide remains responsible for other providers' custom cards.
      const releaseLauncher = registry.register({
        id: guideId, kind: "minke.launcher", title: () => t("tab.new"),
        guide: [{ id: "minke", order: 50, title: () => "Minke" }],
      });
      const releaseLauncherBody = ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
        name: "sidebar.right.pane.tab", key: guideId, locale: TABS_NAMESPACE, inject: injectGuide,
      }, LegacyNativeTabGuide as ComponentType<never>));
      const releaseGuide = ctx.slots.inject("sidebar.right.tab.guide.entry", () => ctx.slots.register({
        name: "sidebar.right.tab.guide.entry", key: guideId, locale: TABS_NAMESPACE,
        inject: injectGuide,
      }, NativeTabGuide as ComponentType<never>));
      const releaseConnection = native.connect(sidebar);
      return () => {
        releaseConnection();
        releaseResources();
        releaseGuide();
        releaseLauncherBody();
        releaseLauncher();
        releaseTypes();
        for (const releases of registered.values()) for (const release of releases.reverse()) release();
      };
    }, "minke-overlay: native Sidebar tabs");
  });
  return native;
}
