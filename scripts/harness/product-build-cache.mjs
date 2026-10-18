import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fingerprintPaths, fingerprintRecord, writeFileAtomic } from "./runtime-state.mjs";

async function fingerprintInputs(root, paths) {
  // esbuild resolves linked dependencies outside a fixture or worktree. Hash
  // those exact input files without relaxing staged-runtime path containment.
  return fingerprintRecord(await Promise.all([...paths].sort().map(async path => {
    const absolute = resolve(root, path);
    let resolved;
    try { resolved = await realpath(absolute); }
    catch (error) { if (error.code !== "ENOENT") throw error; resolved = absolute; }
    return [path, await fingerprintPaths(dirname(resolved), [basename(resolved)])];
  })));
}

/** Cache only verified build outputs; edits, missing files and environment changes invalidate it. */
export async function reusableProductBuild(root, cachePath, environment, outputs) {
  let cached;
  try { cached = JSON.parse(await readFile(cachePath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
  if (cached === null || typeof cached !== "object" || cached.version !== 1 ||
      !Array.isArray(cached.inputs) || !cached.inputs.every(path => typeof path === "string") ||
      cached.environment !== fingerprintRecord(environment)) return false;
  const [inputs, output] = await Promise.all([
    fingerprintInputs(root, cached.inputs),
    fingerprintPaths(root, outputs),
  ]);
  return inputs === cached.inputFingerprint && output === cached.outputFingerprint;
}

export async function recordProductBuild(root, cachePath, environment, inputs, outputs) {
  const paths = [...new Set(inputs)].sort();
  const [inputFingerprint, outputFingerprint] = await Promise.all([
    fingerprintInputs(root, paths),
    fingerprintPaths(root, outputs),
  ]);
  await writeFileAtomic(cachePath, JSON.stringify({
    version: 1, environment: fingerprintRecord(environment), inputs: paths,
    inputFingerprint, outputFingerprint,
  }) + "\n");
}
