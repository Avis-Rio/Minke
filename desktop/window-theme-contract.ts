/** Renderer-to-main channel carrying the app's native window appearance. */
export const WINDOW_THEME_CHANNEL = "minke:window-theme";

/** DSH's theme presenter publishes this source on the document root. */
export const WINDOW_THEME_SOURCE_ATTRIBUTE = "data-ds-theme-source";
export type WindowThemeSource = "light" | "dark" | "system";

/** Validate untrusted renderer data before it can change process-wide native UI. */
export function isWindowThemeSource(
  value: unknown,
): value is WindowThemeSource {
  return value === "light" || value === "dark" || value === "system";
}
