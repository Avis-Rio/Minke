import type {
  HarnessClientContext,
} from "../core/context.ts";
import { installDesktopSurface } from "./surface.ts";
import {
  hasMacOSDesktopSurface,
} from "./window.ts";

/** Install Minke's native surface; DSH owns locale and theme presentation. */
export function installDesktopClient(
  ctx: HarnessClientContext,
): void {
  if (hasMacOSDesktopSurface()) {
    ctx.effect(
      () => installDesktopSurface(),
      "minke-overlay: macOS desktop surface",
    );
  }
}
