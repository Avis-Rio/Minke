export function runtimeEntrySource(cliPackageName) {
  return `if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
  throw new Error("Minke staged Harness entry requires embedded Node mode");
}

await import("./bin/node-environment-bootstrap.cjs");

function report(error, seen = new Set(), indent = "") {
  if (error !== null && typeof error === "object") {
    if (seen.has(error)) return;
    seen.add(error);
  }
  const rendered = error instanceof Error ? error.stack || error.message : String(error);
  console.error(\`\${indent}\${rendered}\`);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) report(nested, seen, \`\${indent}  \`);
  }
  if (error instanceof Error && error.cause !== undefined) {
    report(error.cause, seen, \`\${indent}  caused by: \`);
  }
}

try {
  if (process.argv[2] === "--minke-desktop-host") {
    const { runProfile } = await import("${cliPackageName}/profile-boot");
    const { loadLayeredEnv } = await import("@deepseek-ai/dsh-app-boot");
    const { runDesktopHost } = await import("./desktop-host.mjs");
    await runDesktopHost(() => runProfile({
      environment: loadLayeredEnv("dsh"),
      profile: "web",
      patchFiles: [process.argv[3]],
      args: ["--no-open", "--host", "127.0.0.1", "--port", "0"],
      packageManager: {
        command: process.execPath,
        args: ["--expose-internals", process.argv[4]],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    }));
  } else {
    const { runCli } = await import("${cliPackageName}/lib/bin.js");
    await runCli();
  }
} catch (error) {
  report(error);
  process.exitCode = 1;
  if (process.argv[2] === "--minke-desktop-host" && process.connected) {
    const { inspect } = await import("node:util");
    process.send({ type: "fatal", message: error instanceof Error ? error.message : String(error),
      diagnostic: inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, 64 * 1024) },
      () => { if (process.connected) process.disconnect(); });
  }
}
`;
}
