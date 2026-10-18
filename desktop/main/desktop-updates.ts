import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_UPDATE_IPC, type DesktopUpdatePresentation } from "@minke/harness-overlay/shared-updates-contract.ts";

export function bindDesktopUpdates(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  source: { status(): DesktopUpdatePresentation; open(): Promise<void> },
  authorize: (event: IpcMainInvokeEvent) => boolean,
): { dispose(): void } {
  const allowed = (event: IpcMainInvokeEvent): void => {
    if (!authorize(event)) throw new Error("unauthorized desktop update request");
  };
  let opening: Promise<void> | undefined;
  ipc.handle(DESKTOP_UPDATE_IPC.status, event => { allowed(event); return source.status(); });
  ipc.handle(DESKTOP_UPDATE_IPC.open, async event => {
    allowed(event);
    opening ??= source.open().finally(() => { opening = undefined; });
    await opening;
  });
  return { dispose() {
    ipc.removeHandler(DESKTOP_UPDATE_IPC.status);
    ipc.removeHandler(DESKTOP_UPDATE_IPC.open);
  } };
}
