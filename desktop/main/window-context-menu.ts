import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions } from "electron";
import type { DesktopMessageKey } from "../i18n.ts";

/** Native edit actions follow the focused frame's capabilities, as in DSH Desktop. */
export function bindWindowContextMenu(
  window: BrowserWindow,
  menu: Pick<typeof Menu, "buildFromTemplate">,
  text: (key: DesktopMessageKey) => string,
): () => void {
  // BrowserWindow.webContents cannot be read once its "closed" event fires.
  const contents = window.webContents;
  const show = (_event: Electron.Event, { isEditable, selectionText, editFlags }: ContextMenuParams): void => {
    if (window.isDestroyed()) return;
    const items: MenuItemConstructorOptions[] = [];
    const action = (role: "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll", enabled: boolean): MenuItemConstructorOptions => ({
      role, label: text(`edit.${role}`), enabled, accelerator: "",
    });
    if (isEditable) {
      items.push(
        action("undo", editFlags.canUndo), action("redo", editFlags.canRedo),
        { type: "separator" },
        action("cut", editFlags.canCut), action("copy", editFlags.canCopy), action("paste", editFlags.canPaste),
        { type: "separator" }, action("selectAll", editFlags.canSelectAll),
      );
    } else if (selectionText.length > 0) {
      items.push(action("copy", editFlags.canCopy));
    }
    if (items.length > 0) menu.buildFromTemplate(items).popup({ window });
  };
  contents.on("context-menu", show);
  return () => contents.off("context-menu", show);
}
