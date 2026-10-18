import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { writeDeployLockfile } from "../scripts/harness/deploy-lockfile.mjs";

const run = promisify(execFile);
const pnpm = resolve("runtime/host/node_modules/pnpm/bin/pnpm.cjs");

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "minke-locked-deploy-")));
  t.after(() => rm(root, { force: true, recursive: true }));
  const generated = join(root, "apps/runtime");
  const packages = new Map();
  for (const name of ["core", "widget"]) {
    const path = join(root, "packages", name);
    await mkdir(path, { recursive: true });
    packages.set(name, { path });
    await writeFile(join(path, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js", files: ["index.js"],
      ...(name === "widget" ? { dependencies: { core: "workspace:*" } } : {}) }));
    await writeFile(join(path, "index.js"), name === "core" ? "export default 42;" : "export { default } from 'core';");
  }
  await mkdir(generated, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true, packageManager: "pnpm@11.28.5" }));
  await writeFile(join(root, "pnpm-workspace.yaml"), yaml.dump({ packages: ["packages/*", "apps/*"] }));
  const original = yaml.dump({ lockfileVersion: "9.0", settings: { autoInstallPeers: true, excludeLinksFromLockfile: false }, importers: {
    ".": {}, "packages/core": {}, "packages/widget": { dependencies: { core: { specifier: "workspace:*", version: "link:../core" } } },
  } });
  await writeFile(join(root, "pnpm-lock.yaml"), original);
  const manifest = { name: "deploy-test", version: "1.0.0", private: true, dependencies: { widget: "workspace:*" } };
  await writeFile(join(generated, "package.json"), JSON.stringify(manifest));
  return { root, generated, packages, manifest, original };
}

test("a generated runtime deploys the pinned workspace graph without installation or resolution", async t => {
  const f = await fixture(t);
  await writeDeployLockfile(f.root, f.generated, f.packages, f.manifest);
  const destination = join(f.root, "deployed");
  const { stdout } = await run(process.execPath, [pnpm, "--filter", "deploy-test", "deploy", "--prod", "--offline", "--ignore-scripts",
    `--lockfile-dir=${f.generated}`, "--config.inject-workspace-packages=true", "--config.node-linker=hoisted", destination],
  { cwd: f.root, env: process.env, maxBuffer: 1024 * 1024 });
  assert.doesNotMatch(stdout, /resolution step|resolved [1-9]/i);
  const { stdout: value } = await run(process.execPath, ["--input-type=module", "-e", "import value from 'widget'; console.log(value)"], { cwd: destination });
  assert.equal(value.trim(), "42");
  assert.equal(await readFile(join(f.root, "pnpm-lock.yaml"), "utf8"), f.original, "deployment must not mutate the pinned upstream lock");
});

test("runtime generation rejects dependencies absent from the pinned lock", async t => {
  const f = await fixture(t);
  await assert.rejects(writeDeployLockfile(f.root, f.generated, f.packages, { dependencies: { unpinned: "^1.0.0" } }), /No exact pinned/);
  f.packages.set("missing", { path: join(f.root, "packages/missing") });
  await assert.rejects(writeDeployLockfile(f.root, f.generated, f.packages, { dependencies: { missing: "workspace:*" } }), /Missing locked workspace/);
});
