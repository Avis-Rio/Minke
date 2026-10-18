import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { nativeChildEnvironment } from "../../config/embedded-node-runtime.mts";

const MARKER = "\0_MINKE_LOGIN_SHELL_ENV_\0";
const DUMP = "printf '\\0_MINKE_LOGIN_SHELL_ENV_\\0'; command env -0 || exit; printf '\\0_MINKE_LOGIN_SHELL_ENV_\\0'; exit";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROBE_ENVIRONMENT = {
  DISABLE_AUTO_UPDATE: "true",
  ZSH_TMUX_AUTOSTARTED: "true",
  ZSH_TMUX_AUTOSTART: "false",
};
const SESSION_KEYS = new Set([
  "PWD", "OLDPWD", "SHLVL", "_", ...Object.keys(PROBE_ENVIRONMENT),
]);
const LAUNCHER_PREFIXES = ["MINKE_", "DSH_", "ELECTRON_"];

interface LoginShellOptions {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  shells?: readonly string[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface LoginShellResult {
  environment: NodeJS.ProcessEnv;
  failures: { shell: string; reason: string }[];
}

/** Parse only the NUL-framed dump, preserving multiline values and equals signs. */
export function parseLoginShellEnvironment(output: string): Record<string, string> | undefined {
  const start = output.indexOf(MARKER);
  if (start === -1) return undefined;
  const end = output.indexOf(MARKER, start + MARKER.length);
  if (end === -1) return undefined;
  return Object.fromEntries(
    output.slice(start + MARKER.length, end).split("\0").flatMap(entry => {
      const equals = entry.indexOf("=");
      return equals > 0 ? [[entry.slice(0, equals), entry.slice(equals + 1)]] : [];
    }),
  );
}

/** Shell settings win except for process-local state and Minke's launch identity. */
export function mergeLoginShellEnvironment(
  base: NodeJS.ProcessEnv,
  shell: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const result = { ...base };
  for (const [key, value] of Object.entries(shell)) {
    if (SESSION_KEYS.has(key) || LAUNCHER_PREFIXES.some(prefix => key.toUpperCase().startsWith(prefix))) continue;
    Object.defineProperty(result, key, { value, writable: true, enumerable: true, configurable: true });
  }
  return result;
}

/** A separate deadline per candidate; reject timer values Node would clamp. */
export function resolveLoginShellTimeout(environment: NodeJS.ProcessEnv, configured?: number): number {
  const name = "MINKE_LOGIN_SHELL_TIMEOUT_MS";
  const timeout = configured ?? Number(environment[name] ?? 10_000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new RangeError(`${name} must be a whole number of milliseconds between 1 and 2147483647`);
  }
  return timeout;
}

function loginShellCandidates(): readonly string[] {
  let accountShell: string | null = null;
  try {
    accountShell = userInfo().shell;
  } catch (_error) {
    // System shells remain available when the account record cannot be read.
  }
  return [...new Set([
    ...(accountShell ? [accountShell] : []),
    "/bin/zsh", "/bin/bash", "/bin/sh",
  ])];
}

function readShell(
  shell: string,
  base: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, string> | string> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve("aborted"); return; }
    const child = spawn(shell, ["-ilc", DUMP], {
      cwd,
      env: { ...nativeChildEnvironment(base), ...PROBE_ENVIRONMENT },
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let output = Buffer.alloc(0);
    const finish = (result: Record<string, string> | string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.stdout.off("data", onData);
      // Rc files can start background writers; stop retaining output after the dump.
      child.stdout.resume();
      resolve(result);
    };
    const stop = (reason: string): void => {
      if (settled) return;
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (_error) { /* The probe's process group has already exited. */ }
      }
      finish(reason);
    };
    const onAbort = (): void => stop("aborted");
    const onData = (chunk: Buffer): void => {
      if (output.length + chunk.length > MAX_OUTPUT_BYTES) { stop("output limit"); return; }
      output = Buffer.concat([output, chunk]);
      const environment = parseLoginShellEnvironment(output.toString("utf8"));
      // A background child may keep stdout open after the shell exits.
      if (environment !== undefined) finish(environment);
    };
    const timer = setTimeout(() => stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", onData);
    child.once("error", error => finish(error.message));
    child.once("close", (code, exitSignal) => finish(exitSignal ?? `exit ${String(code)} without an environment`));
  });
}

/**
 * Read one POSIX login environment for all desktop-owned runtimes. Failed probes
 * fall back to the next shell, then to the inherited environment; Windows skips
 * probing. Cancellation kills the current process group and skips later shells.
 */
export async function readLoginShellEnvironment(
  base: NodeJS.ProcessEnv,
  options: LoginShellOptions = {},
): Promise<LoginShellResult> {
  if ((options.platform ?? process.platform) === "win32") return { environment: base, failures: [] };
  const timeout = resolveLoginShellTimeout(base, options.timeoutMs);
  const failures: LoginShellResult["failures"] = [];
  for (const shell of options.shells ?? loginShellCandidates()) {
    const result = await readShell(shell, base, options.homeDirectory ?? homedir(), timeout, options.signal);
    if (typeof result !== "string") return { environment: mergeLoginShellEnvironment(base, result), failures };
    failures.push({ shell, reason: result });
    if (result === "aborted") break;
  }
  return { environment: base, failures };
}
