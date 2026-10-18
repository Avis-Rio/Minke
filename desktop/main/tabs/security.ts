import {
  normalizeWebTabUrl,
} from "@minke/harness-overlay/tabs/contract.ts";
import {
  normalizeUserGestureExternalLinkUrl,
} from "@minke/harness-overlay/tabs/web-link-contract.ts";
import type {
  ExternalTabOpener,
} from "./types.ts";

export function canGrantTabWebPermission(
  permission: string,
  candidate: string | undefined,
): boolean {
  if (
    permission !== "clipboard-sanitized-write" ||
    candidate === undefined
  ) {
    return false;
  }
  const url = normalizeWebTabUrl(candidate);
  return url !== undefined && new URL(url).protocol === "https:";
}

function openWithHost(
  external: ExternalTabOpener,
  url: string,
): void {
  void external.openExternal(url).catch((error: unknown) => {
    console.error("Minke could not open the external URL:", error);
  });
}

export function openUserGestureTabLinkExternally(
  external: ExternalTabOpener,
  candidate: unknown,
): void {
  if (typeof candidate !== "string") return;
  const url = normalizeUserGestureExternalLinkUrl(candidate);
  if (url !== undefined) openWithHost(external, url);
}

export function openNormalizedTabExternally(
  external: ExternalTabOpener,
  candidate: unknown,
): void {
  if (typeof candidate !== "string") return;
  const url = normalizeWebTabUrl(candidate);
  if (url !== undefined) openWithHost(external, url);
}
