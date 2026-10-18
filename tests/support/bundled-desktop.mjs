import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
const require = createRequire(import.meta.url);
const sources = new Map();

/** Substitute only Electron; execute production TypeScript and its real filesystem/DSH dependencies. */
export function bundledDesktop(path, electron) {
  let code = sources.get(path);
  if (code === undefined) {
    code = buildSync({ entryPoints: [fileURLToPath(new URL(`../../${path}`, import.meta.url))],
      bundle: true, write: false, format: "cjs", platform: "node", external: ["electron"],
      tsconfig: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)), logLevel: "silent" }).outputFiles[0].text;
    sources.set(path, code);
  }
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => name === "electron" ? electron : require(name), module, module.exports);
  return module.exports;
}

export async function until(predicate) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (await predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error("Desktop fixture did not reach the expected state");
}
