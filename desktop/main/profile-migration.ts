import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { embeddedNodeChildEnvironment } from "../../config/embedded-node-runtime.mts";
import { readHarnessRuntimeLayout, type HarnessRuntimeLayout } from "./harness-launch.ts";
import { runProfileMigrationCommand, type ProfileMigrationCommandRunner } from "./profile-migration/command.ts";
import { parseTerminalSettings, type TerminalSettings } from "@minke/harness-overlay/terminal-settings-contract.ts";

export interface ProfileMigrationOptions {
  runtimeRoot: string;
  dshHome: string;
  electronExecutable: string;
  environment?: NodeJS.ProcessEnv;
  readRuntimeLayout?: () => Promise<HarnessRuntimeLayout>;
  runCommand?: ProfileMigrationCommandRunner;
}

/** Executed by the bundled Node with DSH's own profile validation and lock. */
export const DISABLED_PLUGIN_MIGRATION_SOURCE = String.raw`
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, home, names] = process.argv.slice(1);
const require = createRequire(entry);
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { readProfileManifest } = await load("@deepseek-ai/dsh-app-boot");
const { withFileLock, writeFileAtomic } = await load("@deepseek-ai/dsh-atomic-write");
const dir = join(home, "profiles", "web");
const path = join(dir, "package.json");
const disabled = new Set(JSON.parse(names));
if (existsSync(path)) await withFileLock(path, async () => {
  const manifest = readProfileManifest("dsh", dir);
  const previous = manifest.dsh?.profile?.bundles ?? [];
  const bundles = previous.filter(name => !disabled.has(name));
  if (bundles.length === previous.length) return;
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } };
  await writeFileAtomic(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
});
`;

/** Rename only the old model entry assertion, preserving YAML expressions and comments. */
export const MODEL_PROFILE_MIGRATION_SOURCE = String.raw`
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, home] = process.argv.slice(1);
const require = createRequire(entry);
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { withFileLock, writeFileAtomic } = await load("@deepseek-ai/dsh-atomic-write");
const { parseDocument, isSeq, isMap } = await load("yaml");
for (const dir of [join(home, "profiles", "web"), home]) {
  const path = join(dir, "cordis.patch.yml");
  let before;
  try { before = await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") continue; throw error; }
  if (!before.includes("@deepseek-ai/dsh-llm-pi-ai")) continue;
  await withFileLock(join(dir, "package.json"), async () => {
    before = await readFile(path, "utf8");
    const document = parseDocument(before, {
      customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }],
    });
    if (document.errors[0]) throw document.errors[0];
    if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");
    let changed = false;
    for (const row of document.contents.items) {
      if (!isMap(row) || row.has("insert") || row.get("id") !== "llm-pi-ai"
        || row.get("name") !== "@deepseek-ai/dsh-llm-pi-ai") continue;
      row.set("name", "@lencx/minke-model-runtime/dsh");
      changed = true;
    }
    if (!changed) return;
    try { await writeFile(path + ".before-minke-model-runtime", before, { mode: 0o600, flag: "wx" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    await writeFileAtomic(path, String(document), { mode: 0o600 });
  });
}
`;

/** Migrate both user layers before the desktop Web Profile is composed. */
export async function migrateModelProfile(options: ProfileMigrationOptions): Promise<void> {
  const paths = [join(options.dshHome, "profiles", "web", "cordis.patch.yml"), join(options.dshHome, "cordis.patch.yml")];
  const sources = await Promise.all(paths.map(async path => {
    try { return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }));
  if (!sources.some(source => source.includes("@deepseek-ai/dsh-llm-pi-ai"))) return;
  await runProfileMigration(options, MODEL_PROFILE_MIGRATION_SOURCE);
}

/** Preserve old disabled choices before DSH composes or loads any plugins. */
export async function migrateDisabledProfileBundles(
  options: ProfileMigrationOptions,
  names: readonly string[],
): Promise<void> {
  if (names.length === 0) return;
  await runProfileMigration(options, DISABLED_PLUGIN_MIGRATION_SOURCE, [JSON.stringify(names)]);
}

/** Import legacy terminal typography once per Data Home before theme startup. */
export async function migrateTerminalFontProfile(
  options: ProfileMigrationOptions,
  legacy?: TerminalSettings,
): Promise<void> {
  const marker = join(options.dshHome, "profiles", "web", ".minke-terminal-fonts.json");
  try {
    const saved = JSON.parse(await readFile(marker, "utf8")) as { version?: number };
    if (saved.version !== 1) throw new Error("unsupported terminal font migration record");
    return;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await runProfileMigration(options, TERMINAL_FONT_MIGRATION_SOURCE,
    [JSON.stringify(legacy === undefined ? null : parseTerminalSettings(legacy))]);
}

const TERMINAL_FONT_MIGRATION_SOURCE = String.raw`
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [entry, home, raw] = process.argv.slice(1);
const require = createRequire(entry);
const load = name => import(pathToFileURL(require.resolve(name)).href);
const { withFileLock, writeFileAtomic } = await load("@deepseek-ai/dsh-atomic-write");
const { parseDocument, isSeq, isMap } = await load("yaml");
const legacy = JSON.parse(raw);
const dir = join(home, "profiles", "web");
const path = join(dir, "cordis.patch.yml");
const marker = join(dir, ".minke-terminal-fonts.json");
const read = async path => {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
};
const parse = text => {
  const document = parseDocument(text ?? "[]\n", {
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: value => value }],
  });
  if (document.errors[0]) throw document.errors[0];
  if (document.contents === null) document.contents = document.createNode([]);
  if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence");
  return document;
};
const themeRow = row => isMap(row) && !row.has("insert") && row.get("id") === "ui-theme";
await mkdir(dir, { recursive: true });
await withFileLock(join(dir, "package.json"), async () => {
  if (await read(marker) !== undefined) return;
  const migrated = {};
  if (legacy !== null) {
    const before = await read(path);
    const document = parse(before);
    const homeDocument = parse(await read(join(home, "cordis.patch.yml")));
    // Home overrides own their whole config; leave that explicitly managed theme alone.
    if (!homeDocument.contents.items.some(row => themeRow(row) && row.has("config"))) {
      let row = document.contents.items.findLast(row => themeRow(row) && row.has("config"))
        ?? document.contents.items.findLast(themeRow);
      const config = row?.get("config", true);
      // Never evaluate or replace a dynamic configuration expression.
      if (config === undefined || isMap(config)) {
        const next = config ?? document.createNode({});
        if (!next.has("terminalFontFamily") && legacy.fontFamily !== "") {
          migrated.terminalFontFamily = legacy.fontFamily;
          next.set("terminalFontFamily", legacy.fontFamily);
        }
        if (!next.has("terminalFontSize")) {
          migrated.terminalFontSize = Math.min(20, Math.max(10, legacy.fontSize));
          next.set("terminalFontSize", migrated.terminalFontSize);
        }
        if (Object.keys(migrated).length > 0) {
          if (before !== undefined) {
            try { await writeFile(path + ".before-minke-terminal-fonts", before, { flag: "wx", mode: 0o600 }); }
            catch (error) { if (error.code !== "EEXIST") throw error; }
          }
          if (row === undefined) {
            row = document.createNode({ id: "ui-theme" });
            document.add(row);
          }
          row.set("config", next);
          document.contents.flow = false;
          await writeFileAtomic(path, String(document), { mode: 0o600 });
        }
      }
    }
  }
  // The original desktop values remain a backup; this receipt prevents re-import
  // after a user changes or resets General settings, including after a restart.
  await writeFileAtomic(marker, JSON.stringify({ version: 1, legacy, migrated }, null, 2) + "\n", { mode: 0o600 });
});
`;

async function runProfileMigration(options: ProfileMigrationOptions, source: string, args: string[] = []): Promise<void> {
  const layout = await (options.readRuntimeLayout?.() ?? readHarnessRuntimeLayout(options.runtimeRoot));
  const environment = embeddedNodeChildEnvironment({
    electronExecutable: options.electronExecutable,
    pnpmEntry: layout.pnpmEntry,
    runtimeBin: layout.runtimeBin,
  }, options.environment ?? process.env);
  await (options.runCommand ?? runProfileMigrationCommand)(options.electronExecutable, [
    "--expose-internals", "--require", join(layout.runtimeBin, "node-environment-bootstrap.cjs"),
    "--input-type=module", "--eval", source,
    layout.entryPath, options.dshHome, ...args,
  ], { cwd: options.runtimeRoot, env: environment });
}
