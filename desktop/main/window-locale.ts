import { randomUUID } from "node:crypto";
import {
  isDesktopLocale,
  WINDOW_LOCALE_BOOTSTRAP_CHANNEL,
  WINDOW_LOCALE_CHANNEL,
  type DesktopLocaleBootstrap,
  type DesktopLocale,
} from "@minke/desktop/locale-contract.ts";

/** Lifecycle handle for a window-scoped Harness locale listener. */
export type WindowLocaleBinding = Readonly<{
  dispose(): void;
}>;

type WindowLocaleListener = (event: unknown, locale: unknown) => void;

type WindowLocaleHost = Readonly<{
  webContents: {
    ipc: {
      off(channel: string, listener: WindowLocaleListener): void;
      on(channel: string, listener: WindowLocaleListener): void;
      handle(channel: string, listener: (event: unknown) => Promise<DesktopLocaleBootstrap>): void;
      removeHandler(channel: string): void;
    };
  };
}>;

type DesktopLocaleTarget = Readonly<{
  setLocale(locale: DesktopLocale): void;
}>;

/**
 * Project validated, authorized Harness locale messages into desktop state.
 * The listener is window-scoped so closing a BrowserWindow releases it.
 */
export function bindWindowLocale(
  window: WindowLocaleHost,
  target: DesktopLocaleTarget,
  authorize: (event: unknown) => boolean,
  bootstrap: () => Promise<DesktopLocaleBootstrap>,
): WindowLocaleBinding {
  let disposed = false;
  const ipc = window.webContents.ipc;
  const listener: WindowLocaleListener = (event, locale) => {
    if (!authorize(event) || !isDesktopLocale(locale)) return;
    target.setLocale(locale);
  };
  ipc.on(WINDOW_LOCALE_CHANNEL, listener);
  ipc.handle(WINDOW_LOCALE_BOOTSTRAP_CHANNEL, async event => {
    if (!authorize(event)) throw new Error("unauthorized locale bootstrap");
    return bootstrap();
  });

  return Object.freeze({
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ipc.off(WINDOW_LOCALE_CHANNEL, listener);
      ipc.removeHandler(WINDOW_LOCALE_BOOTSTRAP_CHANNEL);
    },
  });
}

/** Read the native locale's existing Host preference through DSH's settings API. */
export async function readHarnessLocaleBootstrap(
  origin: string,
  languages: readonly string[],
  send: (url: string, init: RequestInit) => Promise<Response>,
): Promise<DesktopLocaleBootstrap> {
  const rpcId = randomUUID();
  const method = "settings/describe";
  const response = await send(new URL(`/api/${method}`, origin).href, {
    method: "POST", credentials: "include", redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload: { args: {} } }),
  });
  if (!response.ok) throw new Error("locale bootstrap: settings request failed");
  const envelope = record(await response.json());
  const result = record(envelope?.result);
  const settings = record(result?.value);
  if (envelope?.type !== "server-response" || envelope.rpcId !== rpcId || result?.ok !== true
    || !Array.isArray(settings?.namespaces)) throw new Error("locale bootstrap: invalid settings response");
  const locale = settings.namespaces.map(record).find(item => item?.ns === "locale");
  const value = record(locale?.value);
  if (value === undefined || (value.preference !== undefined && typeof value.preference !== "string")) {
    throw new Error("locale bootstrap: invalid locale preference");
  }
  return { languages: [...languages], preference: value.preference as string | undefined ?? null };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
