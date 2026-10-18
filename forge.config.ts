import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneMacElectronLocales } from "./scripts/forge/electron-locales.ts";
import {
  parsePackageArtifactPolicy,
  verifyPackagedApplication,
} from "./scripts/forge/package-artifact.ts";
import {
  resolveMacOSSigningConfig,
} from "./scripts/forge/macos-signing.ts";

const projectRoot = __dirname;
const iconRoot = join(projectRoot, "resources", "icons");
const appIcon = join(iconRoot, "icon.png");
const macOSSigning = resolveMacOSSigningConfig(process.env);
// electron-installer-debian supports compression; Forge's option type omits it.
const debOptions = {
  bin: "Minke",
  icon: appIcon,
  compression: "xz",
};

function logPackageStage(
  platform: string,
  arch: string,
  stage: string,
): void {
  console.log(`[packager:${platform}-${arch}] ${stage}`);
}

const config: ForgeConfig = {
  hooks: {
    packageAfterCopy: async (
      _forgeConfig,
      _buildPath,
      _electronVersion,
      platform,
      arch,
    ) => {
      logPackageStage(
        platform,
        String(arch),
        "package copy hook started",
      );
      logPackageStage(
        platform,
        String(arch),
        "package copy hook completed",
      );
    },
    postPackage: async (
      _forgeConfig,
      { arch, outputPaths, platform },
    ) => {
      const [runtimeContract, artifactPolicy] = await Promise.all([
        readFile(
          join(projectRoot, "config", "harness-runtime.json"),
          "utf8",
        ).then(JSON.parse),
        readFile(
          join(projectRoot, "config", "package-artifact.json"),
          "utf8",
        ).then(JSON.parse).then(parsePackageArtifactPolicy),
      ]);
      for (const outputPath of outputPaths) {
        const report = await verifyPackagedApplication(outputPath, {
          appSizeBudgetBytes:
            artifactPolicy.appSizeBudgetBytes[platform],
          arch: String(arch),
          platform,
          productPackageName:
            runtimeContract.productBundle.packageName,
          runtimeFileBudget: runtimeContract.runtimeFileBudget,
          runtimeSizeBudgetBytes:
            runtimeContract.runtimeSizeBudgetBytes[platform],
        });
        console.log(
          `Verified packaged Host ${(report.host.bytes / 1024 / 1024).toFixed(1)} MiB/${String(report.host.files)} files and app ${(report.app.bytes / 1024 / 1024).toFixed(1)} MiB`,
        );
      }
    },
  },
  packagerConfig: {
    name: "Minke",
    executableName: "Minke",
    appBundleId: "me.lencx.minke",
    appCategoryType: "public.app-category.developer-tools",
    extendInfo: {
      NSMicrophoneUsageDescription: "Minke uses your microphone to transcribe speech into message drafts.",
    },
    osxSign: {
      // A stable certificate keeps the Keychain ACL valid across updates.
      // Local machines without one retain the pre-release ad-hoc fallback.
      identity: macOSSigning.identity,
      identityValidation: macOSSigning.identityValidation,
      ...(macOSSigning.keychain === undefined
        ? {}
        : { keychain: macOSSigning.keychain }),
      optionsForFile: () => ({
        hardenedRuntime: false,
        entitlements: join(projectRoot, "scripts", "forge", "macos-entitlements.plist"),
      }),
    },
    asar: true,
    // The Vite plugin copies only .vite. Packager pruning would otherwise walk
    // the complete pnpm graph before that ignore policy, retaining redundant
    // production packages and consuming several GiB on every desktop OS.
    prune: false,
    icon: join(iconRoot, "icon"),
    afterCopy: [
      (
        _buildPath,
        _electronVersion,
        platform,
        arch,
        callback,
      ) => {
        logPackageStage(
          platform,
          String(arch),
          "native dependencies ready",
        );
        callback();
      },
    ],
    beforeAsar: [
      (
        _buildPath,
        _electronVersion,
        platform,
        arch,
        callback,
      ) => {
        logPackageStage(platform, String(arch), "asar started");
        callback();
      },
    ],
    afterAsar: [
      (
        _buildPath,
        _electronVersion,
        platform,
        arch,
        callback,
      ) => {
        logPackageStage(platform, String(arch), "asar completed");
        callback();
      },
    ],
    beforeCopyExtraResources: [
      (
        _buildPath,
        _electronVersion,
        platform,
        arch,
        callback,
      ) => {
        logPackageStage(
          platform,
          String(arch),
          "extra resources started",
        );
        callback();
      },
    ],
    afterCopyExtraResources: [
      (buildPath, _electronVersion, platform, arch, callback) => {
        if (platform !== "darwin") {
          logPackageStage(
            platform,
            String(arch),
            "extra resources completed",
          );
          callback();
          return;
        }
        void pruneMacElectronLocales(join(buildPath, "Minke.app")).then(
          (result) => {
            console.log(
              `Pruned ${String(result.removed.length)} unused Electron locales`,
            );
            logPackageStage(
              platform,
              String(arch),
              "extra resources completed",
            );
            callback();
          },
          (error: unknown) => {
            callback(
              error instanceof Error
                ? error
                : new Error(String(error)),
            );
          },
        );
      },
    ],
    afterComplete: [
      (
        _buildPath,
        _electronVersion,
        platform,
        arch,
        callback,
      ) => {
        logPackageStage(
          platform,
          String(arch),
          "package completed",
        );
        callback();
      },
    ],
    extraResource: [
      join(projectRoot, "runtime", "host"),
      join(projectRoot, "resources", "licenses"),
      appIcon,
      join(iconRoot, "trayTemplate.png"),
      join(iconRoot, "trayTemplate@2x.png"),
    ],
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "Minke",
      setupIcon: join(iconRoot, "icon.ico"),
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDMG({
      // appdmg supports ULMO (macOS 10.15+), below Electron's minimum OS.
      // @ts-expect-error Remove when electron-installer-dmg declares ULMO; verified by making and mounting the DMG.
      format: "ULMO",
      icon: join(iconRoot, "icon.icns"),
    }),
    new MakerRpm({
      options: {
        bin: "Minke",
        icon: appIcon,
        compressionLevel: 6,
      },
    }),
    new MakerDeb({
      options: debOptions,
    }),
  ],
  plugins: [
    new VitePlugin({
      build: [
        {
          entry: "desktop/main/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "desktop/preload/desktop-preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
        {
          entry: "desktop/preload/tabs-web-preload.ts",
          config: "vite.tabs-web-preload.config.mts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      // Harness and the bundled pnpm run as isolated Node processes through
      // Electron's own runtime, so a second standalone Node binary is unnecessary.
      [FuseV1Options.RunAsNode]: true,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
