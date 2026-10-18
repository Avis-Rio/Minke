import type { App } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { environmentValue, setEnvironmentName } from "../../config/embedded-node-runtime.mts";

/** Isolate development data before Electron acquires storage or an instance lock. */
export function configureAppDataPaths(
  app: Pick<App, "getPath" | "setPath" | "getAppPath" | "isPackaged">,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const developmentRoot = app.isPackaged
    ? undefined
    : join(app.getAppPath(), "work", "development");
  const dataPath = developmentRoot === undefined
    ? join(app.getPath("home"), ".minke")
    : join(developmentRoot, "electron");
  if (developmentRoot !== undefined && !environmentValue(environment, "DSH_HOME")?.trim()) {
    setEnvironmentName(environment, "DSH_HOME", join(developmentRoot, "harness"));
  }
  mkdirSync(dataPath, { recursive: true, mode: 0o700 });
  app.setPath("userData", dataPath);
  app.setPath("sessionData", dataPath);
}
