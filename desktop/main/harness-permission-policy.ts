import type {
  Session,
  WebContents,
} from "electron";

export const HARNESS_CLIPBOARD_WRITE_PERMISSION =
  "clipboard-sanitized-write";

export interface HarnessPermissionRequest {
  permission: string;
  candidateUrl: string | undefined;
  harnessUrl: string | undefined;
  requestingWebContents: unknown;
  activeWebContents: unknown;
  isMainFrame?: boolean;
  mediaTypes?: readonly string[];
}

/**
 * Grant clipboard writes and main-frame audio only to the active Harness
 * renderer. Microphone access additionally requires operating-system consent.
 */
export function canGrantHarnessPermission(
  request: HarnessPermissionRequest,
): boolean {
  if (
    (request.permission !== HARNESS_CLIPBOARD_WRITE_PERMISSION &&
      !(request.permission === "media" &&
        request.isMainFrame === true &&
        request.mediaTypes?.length === 1 &&
        request.mediaTypes[0] === "audio")) ||
    request.candidateUrl === undefined ||
    request.harnessUrl === undefined ||
    request.requestingWebContents === null ||
    request.requestingWebContents === undefined ||
    request.requestingWebContents !== request.activeWebContents
  ) {
    return false;
  }

  try {
    return new URL(request.candidateUrl).origin ===
      new URL(request.harnessUrl).origin;
  } catch {
    return false;
  }
}

export interface HarnessPermissionSources {
  harnessUrl(): string | undefined;
  activeWebContents(): WebContents | undefined;
  microphone?: {
    isGranted(): boolean;
    request(): Promise<boolean>;
  };
}

/** Install the fail-closed main-renderer policy on one Electron session. */
export function installHarnessPermissionPolicy(
  target: Pick<
    Session,
    "setPermissionCheckHandler" | "setPermissionRequestHandler"
  >,
  sources: HarnessPermissionSources,
): void {
  target.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) =>
      canGrantHarnessPermission({
        permission,
        candidateUrl:
          details.requestingUrl ?? requestingOrigin,
        harnessUrl: sources.harnessUrl(),
        requestingWebContents: webContents,
        activeWebContents: sources.activeWebContents(),
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType === undefined ? [] : [details.mediaType],
      }) && (permission !== "media" || sources.microphone?.isGranted() === true),
  );
  target.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const allowed = (candidateUrl = details.requestingUrl) =>
        canGrantHarnessPermission({
          permission,
          candidateUrl,
          harnessUrl: sources.harnessUrl(),
          requestingWebContents: webContents,
          activeWebContents: sources.activeWebContents(),
          isMainFrame: details.isMainFrame,
          mediaTypes: "mediaTypes" in details ? details.mediaTypes : undefined,
        });
      const trusted = allowed();
      if (!trusted || permission !== "media") {
        callback(trusted);
        return;
      }
      const microphone = sources.microphone;
      if (microphone === undefined) { callback(false); return; }
      void Promise.resolve().then(() => microphone.request()).then(
        granted => callback(granted && !webContents.isDestroyed() && allowed(webContents.getURL())),
        () => callback(false),
      );
    },
  );
}
