import type { DesktopUpdateBridge } from "../../shared-updates-contract.ts";
import type { ComponentType } from "react";
import type {
  HarnessClientContext,
} from "../core/context.ts";
import {
  desktopAboutInfo,
  desktopTabsPort,
} from "../desktop/index.ts";
import {
  aboutEn,
  aboutZh,
  installAboutStyles,
  MinkeAboutDialog,
  type AboutLocaleKey,
  type AboutTranslate,
} from "./index.tsx";

const ABOUT_NAMESPACE = "minke.about";

/** Register the desktop-only About action and dialog. */
export function installAbout(ctx: HarnessClientContext): void {
  const aboutInfo = desktopAboutInfo();
  if (!aboutInfo.available) return;

  const tabsPort = desktopTabsPort();
  const carrier = (globalThis as typeof globalThis & {
    dshDesktop?: { protocolVersion: number; updates?: DesktopUpdateBridge };
  }).dshDesktop;
  const updates = carrier?.protocolVersion === 1 ? carrier.updates : undefined;
  ctx.effect(
    () =>
      ctx.locale.register(ABOUT_NAMESPACE, {
        zh: aboutZh,
        en: aboutEn,
      }),
    "minke-overlay: About dictionaries",
  );
  const aboutT = ctx.locale.bind<AboutLocaleKey>(
    ABOUT_NAMESPACE,
  ) as AboutTranslate;
  ctx.effect(
    () => installAboutStyles(),
    "minke-overlay: About styles",
  );
  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register(
      {
        name: "sidebar.footer.action",
        id: "minke-about",
        order: 100,
        label: () => aboutT("trigger"),
        locale: ABOUT_NAMESPACE,
        inject: () => ({
          openUpdates: updates === undefined ? undefined : () => {
            void updates.open().catch((error: unknown) => { console.warn("Desktop update action failed", error); });
          },
          info: aboutInfo,
          openExternal: (url: string) => {
            tabsPort.openExternal(url);
          },
        }),
      },
      MinkeAboutDialog as ComponentType<never>,
    ),
  );
}
