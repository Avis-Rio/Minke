import { readFile, mkdir, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ShortcutPersistence, parseBinding } from "@deepseek-ai/dsh-client-shortcuts/protocol";
import type { ShortcutConfigSnapshot, ShortcutDocument, ShortcutPlatform } from "@deepseek-ai/dsh-client-shortcuts/protocol";
import { DEFAULT_SHORTCUT_BINDINGS, type ShortcutBindings } from "@minke/harness-overlay/shortcut-contract.ts";
import { legacyShortcutBinding, shortcutCommandId } from "@minke/harness-overlay/shared-shortcuts-contract.ts";

/** Keep legacy effective bindings once; subsequent edits use DSH's revisioned document. */
export function migrateShortcutBindings(bindings: ShortcutBindings, platform: ShortcutPlatform,
  unsupported: string[] = []): ShortcutDocument {
  const overrides = Object.fromEntries(Object.entries({ ...DEFAULT_SHORTCUT_BINDINGS, ...bindings })
    .map(([id, binding]) => {
      try { return [shortcutCommandId(id), parseBinding(legacyShortcutBinding(binding))]; }
      catch { unsupported.push(`${id}: ${binding}`); return [shortcutCommandId(id), null]; }
    }));
  return { schemaVersion: 1, profiles: { [`desktop:${platform}`]: overrides } };
}

/** One DSH writer, with atomic files and a non-destructive, one-time legacy import. */
export function desktopKeybindings(
  userData: string, platform: ShortcutPlatform,
  publish: (snapshot: ShortcutConfigSnapshot) => void,
  legacy: (() => Promise<ShortcutBindings>) | undefined,
  onUnsupported: (bindings: string[]) => void = () => {},
): ShortcutPersistence {
  const path = join(userData, "keybindings.json");
  const write = async (raw: string): Promise<void> => {
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, raw, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  };
  return new ShortcutPersistence({
    read: async () => {
      try { return await readFile(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const unsupported: string[] = [];
      const document = legacy === undefined ? { schemaVersion: 1, profiles: {} }
        : migrateShortcutBindings(await legacy(), platform, unsupported);
      const raw = `${JSON.stringify(document, null, 2)}\n`;
      await write(raw);
      if (unsupported.length > 0) onUnsupported(unsupported);
      return raw;
    }, write,
  }, "desktop", platform, false, publish);
}
