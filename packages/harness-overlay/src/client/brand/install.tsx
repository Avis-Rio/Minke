import type { ComponentType } from "react";
import type {
  HarnessClientContext,
} from "../core/context.ts";
import {
  desktopTabsPort,
} from "../desktop/index.ts";
import {
  MinkeBrandMark,
  MinkeBrandName,
} from "./MinkeBrand.tsx";
import { defineOverlayStyle } from "../shared/style-runtime.ts";
import DESKTOP_BRAND_STYLES from "./desktop.css";

const MINKE_BRAND_PRIORITY = -100;
const installDesktopBrandStyles = defineOverlayStyle("desktop-brand", DESKTOP_BRAND_STYLES);

/** Keep the desktop sidebar clear; the Web projection carries Minke branding. */
export function installBrand(ctx: HarnessClientContext): void {
  if (desktopTabsPort().embeddedWebAvailable) {
    for (const name of ["sidebar.brand.mark", "sidebar.brand.name"]) {
      ctx.slots.inject(name, () => ctx.slots.register(
        { name, priority: MINKE_BRAND_PRIORITY },
        () => null,
      ));
    }
    ctx.effect(() => installDesktopBrandStyles(), "minke-overlay: desktop sidebar brand");
    return;
  }

  for (const name of [
    "conversation.hero.brand.mark",
    "sidebar.brand.mark",
  ]) {
    ctx.slots.inject(name, () =>
      ctx.slots.register(
        {
          name,
          priority: MINKE_BRAND_PRIORITY,
        },
        MinkeBrandMark as ComponentType<never>,
      )
    );
  }
  ctx.slots.inject("sidebar.brand.name", () =>
    ctx.slots.register(
      {
        name: "sidebar.brand.name",
        priority: MINKE_BRAND_PRIORITY,
      },
      MinkeBrandName as ComponentType<never>,
    ),
  );
}
