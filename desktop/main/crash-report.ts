import { randomUUID } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { redactLaunchTokens } from "./harness-host-channel.ts";

export type DesktopFailureSource = "startup" | "host" | "renderer" | "shutdown";
const REPORT_NAME = /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:startup|host|renderer|shutdown)(?:-[a-f0-9-]{36})?\.log$/u;

/** Bounded renderer diagnostics; keep credentials out of startup URL output. */
export class RendererConsoleTail {
  #tail = "";
  append(value: string): void {
    this.#tail = `${this.#tail}${value}\n`.slice(-64 * 1024);
  }
  snapshot(): string { return redactLaunchTokens(this.#tail); }
}

export function formatDesktopFailure(error: unknown): string {
  return redactLaunchTokens(inspect(error, { depth: 6, maxStringLength: 64 * 1024, maxArrayLength: 100 })).slice(0, 256 * 1024);
}

/** Keep ten private reports, pruning only files owned by this reporter. */
export async function writeDesktopCrashReport(
  directory: string,
  error: unknown,
  source: DesktopFailureSource,
  rendererConsole: string,
  version: string,
  time = new Date(),
  phase: "startup" | "running" | "shutdown" = source === "startup" || source === "shutdown" ? source : "running",
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `crash-${time.toISOString().replaceAll(/[:.]/gu, "-")}-${source}-${randomUUID()}.log`);
  const report = [
    `Minke ${version}`, `time: ${time.toISOString()}`, `source: ${source}`, `phase: ${phase}`,
    `platform: ${process.platform}/${process.arch}`, `Electron: ${process.versions.electron ?? "unknown"}`,
    `Node: ${process.versions.node}`, "", formatDesktopFailure(error), "",
    "--- renderer errors ---", redactLaunchTokens(rendererConsole).slice(-64 * 1024), "",
  ].join("\n");
  await writeFile(path, report, { mode: 0o600, flag: "wx" });
  try {
    const names = (await readdir(directory)).filter(name => REPORT_NAME.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - 10))) await unlink(join(directory, name));
  } catch (failure) { console.warn("Unable to prune Minke diagnostics", failure); }
  return path;
}
