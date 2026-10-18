import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { resolvePathAlias } from "../config/path-aliases.mts";

const projectRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
const harnessSourcePrefix =
  `${pathToFileURL(resolve(projectRoot, "vendor/deepseek-harness")).href}/`;
const projectRequire = createRequire(import.meta.url);

registerHooks({
  load(url, context, nextLoad) {
    // Upstream source uses TypeScript parameter properties, which Node's
    // strip-only loader cannot execute in source-level compatibility tests.
    // The product Remote service also uses the standard method decorators.
    if (
      url.endsWith(".tsx") ||
      url.endsWith("/packages/harness-overlay/src/host/workspace-api.ts") ||
      (url.startsWith(harnessSourcePrefix) && url.endsWith(".ts"))
    ) {
      const filename = fileURLToPath(url);
      const result = transformSync(readFileSync(filename, "utf8"), {
        format: "esm",
        jsx: "automatic",
        loader: url.endsWith(".tsx") ? "tsx" : "ts",
        sourcefile: filename,
        sourcemap: "inline",
        target: "es2022",
      });
      return {
        format: "module",
        shortCircuit: true,
        source: result.code,
      };
    }
    if (url.endsWith(".css")) {
      const css = readFileSync(fileURLToPath(url), "utf8");
      // Node component tests need CSS-module class identities, while ordinary
      // overlay sheets remain text. Rendering/CSS is exercised in Electron.
      const value = url.endsWith(".module.css")
        ? Object.fromEntries([...css.matchAll(/\.([A-Za-z_][\w-]*)/gu)].map(([, name]) => [name, name]))
        : css;
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(
          value,
        )};`,
      };
    }
    return nextLoad(url, context);
  },
  resolve(specifier, context, nextResolve) {
    // DSH shares the shell's React at runtime. Node tests likewise share the
    // test renderer's copy instead of mixing the linked checkout's React 18
    // with the product test harness's React 19.
    if (context.parentURL?.startsWith(harnessSourcePrefix) && /^react(?:-dom)?(?:\/|$)/u.test(specifier)) {
      return nextResolve(pathToFileURL(projectRequire.resolve(specifier)).href, context);
    }
    return nextResolve(
      resolvePathAlias(specifier, projectRoot) ?? specifier,
      context,
    );
  },
});
