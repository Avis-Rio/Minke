import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mergeLoginShellEnvironment,
  parseLoginShellEnvironment,
  readLoginShellEnvironment,
  resolveLoginShellTimeout,
} from "@minke/desktop/main/login-shell-environment.ts";

const marker = "\0_MINKE_LOGIN_SHELL_ENV_\0";

test("login environment framing ignores startup output and preserves multiline values", () => {
  const output = `banner\nIGNORE=outside${marker}PATH=/tools:/bin\0VALUE=one\ntwo=three\0EMPTY=\0${marker}logout`;
  assert.deepEqual(parseLoginShellEnvironment(output), { PATH: "/tools:/bin", VALUE: "one\ntwo=three", EMPTY: "" });
  assert.equal(parseLoginShellEnvironment("PATH=/wrong"), undefined);
  assert.equal(parseLoginShellEnvironment(`${marker}PATH=/incomplete`), undefined);
});

test("shell configuration cannot replace desktop identity or import probe state", () => {
  const base = { PATH: "/bin", DSH_HOME: "/selected", MINKE_NODE_EXECUTABLE: "/minke", PWD: "/launch" };
  const shell = {
    PATH: "/configured/bin", HTTPS_PROXY: "http://localhost:1234", DSH_HOME: "/wrong",
    MINKE_NODE_EXECUTABLE: "/wrong", minke_host_root: "/wrong", ELECTRON_RUN_AS_NODE: "1",
    PWD: "/probe", SHLVL: "5", DISABLE_AUTO_UPDATE: "true",
  };
  assert.deepEqual(mergeLoginShellEnvironment(base, shell), {
    ...base, PATH: "/configured/bin", HTTPS_PROXY: "http://localhost:1234",
  });
  assert.equal(base.PATH, "/bin");
});

test("login-shell deadlines reject values that would disable or overflow the timer", () => {
  assert.equal(resolveLoginShellTimeout({}), 10_000);
  assert.equal(resolveLoginShellTimeout({ MINKE_LOGIN_SHELL_TIMEOUT_MS: "3000" }), 3000);
  for (const value of ["", "0", "-1", "1.5", "Infinity", "2147483648", "no"]) {
    assert.throws(() => resolveLoginShellTimeout({ MINKE_LOGIN_SHELL_TIMEOUT_MS: value }), /MINKE_LOGIN_SHELL_TIMEOUT_MS/);
  }
});

test("Windows uses the inherited environment without spawning a shell", async () => {
  const base = { PATH: "C:\\Tools", DSH_HOME: "C:\\Data" };
  const result = await readLoginShellEnvironment(base, { platform: "win32", shells: ["/missing"] });
  assert.equal(result.environment, base);
  assert.deepEqual(result.failures, []);
});

async function shellFixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "minke-login-shell-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shell = join(root, "fixture-shell");
  await writeFile(shell, `#!/bin/sh\n${source}\n`);
  await chmod(shell, 0o700);
  return { shell, root };
}

const posix = { skip: process.platform === "win32" };

test("real login-shell reads retain PATH and proxy configuration through a failed candidate", posix, async t => {
  const { shell, root } = await shellFixture(t, [
    '[ "$1" = "-ilc" ] || exit 11',
    '[ -z "$ELECTRON_RUN_AS_NODE$NODE_OPTIONS$NODE_PATH" ] || exit 12',
    'printf "startup noise\\n"',
    'export PATH="/fixture/tools:/usr/bin:/bin"',
    'export HTTPS_PROXY="http://127.0.0.1:2345"',
    'export DSH_HOME="/shell-must-not-change-home"',
    '/bin/sh -c "$2"',
  ].join("\n"));
  const result = await readLoginShellEnvironment({
    PATH: "/usr/bin:/bin", DSH_HOME: "/selected", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--bad", NODE_PATH: "/bad",
  }, { shells: [join(root, "missing"), shell], homeDirectory: root });
  assert.equal(result.environment.PATH, "/fixture/tools:/usr/bin:/bin");
  assert.equal(result.environment.HTTPS_PROXY, "http://127.0.0.1:2345");
  assert.equal(result.environment.DSH_HOME, "/selected");
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /ENOENT/);
});

test("failed and oversized shell output fall back without importing partial variables", posix, async t => {
  for (const source of ["printf 'PATH=/partial'; exit 7", "yes invalid-output"]) {
    const { shell, root } = await shellFixture(t, source);
    const base = { PATH: "/usr/bin:/bin" };
    const result = await readLoginShellEnvironment(base, { shells: [shell], homeDirectory: root, timeoutMs: 1000 });
    assert.equal(result.environment, base);
    assert.match(result.failures[0].reason, /exit 7|output limit/);
  }
});

test("timeout terminates a blocked probe and tries the next candidate", posix, async t => {
  const blocked = await shellFixture(t, 'exec /bin/sleep 30');
  const ready = await shellFixture(t, '/bin/sh -c "$2"');
  const result = await readLoginShellEnvironment({ PATH: "/usr/bin:/bin" }, {
    shells: [blocked.shell, ready.shell], homeDirectory: ready.root, timeoutMs: 2_000,
  });
  assert.deepEqual(result.failures, [{ shell: blocked.shell, reason: "timeout" }]);
  assert.equal(result.environment.PATH, "/usr/bin:/bin");
});

test("cancellation stops the probe and never tries another shell", posix, async t => {
  const { shell, root } = await shellFixture(t, 'exec /bin/sleep 30');
  const controller = new AbortController();
  const reading = readLoginShellEnvironment({}, { shells: [shell, "/missing"], homeDirectory: root, signal: controller.signal });
  controller.abort();
  assert.deepEqual(await reading, { environment: {}, failures: [{ shell, reason: "aborted" }] });
});
