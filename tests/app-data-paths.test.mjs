import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureAppDataPaths } from "@minke/desktop/main/app-data-paths.ts";
import {
  prepareDesktopApplication,
} from "@minke/desktop/main/application-entry.ts";

test("desktop data and browser session data share ~/.minke", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "minke-app-data-"));
  const calls = [];
  try {
    configureAppDataPaths({
      isPackaged: true,
      getAppPath: () => homePath,
      getPath(name) {
        assert.equal(name, "home");
        return homePath;
      },
      setPath(name, path) {
        calls.push([name, path]);
      },
    });

    const dataPath = join(homePath, ".minke");
    assert.deepEqual(calls, [
      ["userData", dataPath],
      ["sessionData", dataPath],
    ]);
    assert.equal((await stat(dataPath)).isDirectory(), true);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("desktop configures data paths before claiming the process", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "minke-entry-"));
  const calls = [];
  try {
    assert.equal(
      prepareDesktopApplication({
        isPackaged: true,
        getAppPath: () => homePath,
        setName(name) {
          calls.push(["name", name]);
        },
        getPath(name) {
          calls.push(["getPath", name]);
          return homePath;
        },
        setPath(name, path) {
          calls.push(["setPath", name, path]);
        },
        requestSingleInstanceLock() {
          calls.push(["lock"]);
          return true;
        },
        quit() {
          calls.push(["quit"]);
        },
      }),
      true,
    );
    assert.deepEqual(calls, [
      ["name", "Minke"],
      ["getPath", "home"],
      ["setPath", "userData", join(homePath, ".minke")],
      ["setPath", "sessionData", join(homePath, ".minke")],
      ["lock"],
    ]);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("a duplicate desktop process yields the single-instance claim", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "minke-entry-"));
  let quitCalls = 0;
  try {
    assert.equal(
      prepareDesktopApplication({
        isPackaged: true,
        getAppPath: () => homePath,
        setName() {},
        getPath: () => homePath,
        setPath() {},
        requestSingleInstanceLock: () => false,
        quit() {
          quitCalls += 1;
        },
      }),
      false,
    );
    assert.equal(quitCalls, 1);
  } finally {
    await rm(homePath, { recursive: true, force: true });
  }
});

test("development isolates Electron and Harness state from the installed app", async () => {
  const root = await mkdtemp(join(tmpdir(), "minke-development-data-"));
  const environment = {};
  const paths = {};
  try {
    const app = {
      isPackaged: false,
      getAppPath: () => root,
      getPath() { throw new Error("development must not read the production home"); },
      setPath(name, path) { paths[name] = path; },
    };
    configureAppDataPaths(app, environment);
    assert.equal(paths.userData, join(root, "work", "development", "electron"));
    assert.equal(paths.sessionData, paths.userData);
    assert.equal(environment.DSH_HOME, join(root, "work", "development", "harness"));
    assert.equal((await stat(paths.userData)).isDirectory(), true);
    const explicit = { DSH_HOME: join(root, "explicit-test-profile") };
    configureAppDataPaths(app, explicit);
    assert.equal(explicit.DSH_HOME, join(root, "explicit-test-profile"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
