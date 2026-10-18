import type {
  DesktopAboutInfo,
  DesktopBridgeWindow,
} from "./contracts.ts";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Read immutable product metadata projected by the isolated preload. */
export function desktopAboutInfo(
  source: DesktopBridgeWindow =
    window as unknown as DesktopBridgeWindow,
): DesktopAboutInfo {
  const about = source.minkeDesktop?.about;
  if (
    about === undefined ||
    !isNonEmptyString(about.productName) ||
    !isNonEmptyString(about.version) ||
    !isNonEmptyString(about.platform) ||
    !isNonEmptyString(about.arch)
  ) {
    return {
      available: false,
      productName: "Minke",
      version: "",
      platform: "",
      arch: "",
    };
  }
  return {
    available: true,
    productName: about.productName,
    version: about.version,
    platform: about.platform,
    arch: about.arch,
  };
}

/** True only inside the native macOS window that supplies the early surface. */
export function hasMacOSDesktopSurface(
  source: DesktopBridgeWindow =
    window as unknown as DesktopBridgeWindow,
): boolean {
  return source.minkeDesktop?.surface?.kind === "macos";
}
