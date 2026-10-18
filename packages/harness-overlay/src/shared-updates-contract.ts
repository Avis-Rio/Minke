export type { DesktopUpdateBridge, DesktopUpdatePresentation } from "@deepseek-ai/dsh-client-ui-settings-general/types";

/** Standard DSH Desktop presentation and native-dialog channels. */
export const DESKTOP_UPDATE_IPC = Object.freeze({
  status: "dsh-desktop:updates-status",
  open: "dsh-desktop:updates-open",
  changed: "dsh-desktop:updates-presentation",
});
