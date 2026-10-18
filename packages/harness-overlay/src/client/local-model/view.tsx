import { Switch } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  LOCAL_MODEL_RUNTIMES,
  type LocalModelRuntimeId,
} from "@lencx/minke-model-runtime/contract";
import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  SlotService,
} from "../core/context.ts";
import type {
  LocalModelTranslate,
} from "./locales.ts";
import type {
  LocalModelSettingsRuntime,
  LocalModelSettingsSnapshot,
} from "./runtime.ts";

const LOCAL_MODEL_FOOTER_ID = "minke-local-model-runtimes";

type LocalModelRuntimeDescriptor =
  (typeof LOCAL_MODEL_RUNTIMES)[number];

interface LocalModelSlotInjected {
  readonly runtime: LocalModelSettingsRuntime;
  readonly t: LocalModelTranslate;
}

function useLocalModelSettings(
  runtime: LocalModelSettingsRuntime,
): LocalModelSettingsSnapshot {
  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );
  const retriedRead = useRef(false);
  useEffect(() => {
    if (snapshot.error !== "read") {
      retriedRead.current = false;
      return;
    }
    if (retriedRead.current) return;
    retriedRead.current = true;
    void runtime.retry();
  }, [runtime, snapshot.error]);
  return snapshot;
}

function runtimeStatus(
  id: LocalModelRuntimeId,
  snapshot: LocalModelSettingsSnapshot,
  t: LocalModelTranslate,
): string {
  if (snapshot.error === "read") return t("readError");
  if (snapshot.status[id].error === "write") return t("writeError");
  if (snapshot.status[id].applying) return t("applying");
  if (!snapshot.available[id]) return t("commandNotFound");
  return t("restartRequired");
}

interface LocalModelRuntimeSwitchProps {
  readonly descriptor: LocalModelRuntimeDescriptor;
  readonly runtime: LocalModelSettingsRuntime;
  readonly snapshot: LocalModelSettingsSnapshot;
  readonly t: LocalModelTranslate;
}

function LocalModelRuntimeSwitch({
  descriptor,
  runtime,
  snapshot,
  t,
}: LocalModelRuntimeSwitchProps): ReactNode {
  const id = descriptor.id;
  const status = runtimeStatus(id, snapshot, t);
  const autoStart = t("autoStart");
  const disabled =
    !snapshot.editable ||
    !snapshot.available[id] ||
    snapshot.status[id].applying;

  return (
    <span
      data-minke-local-model-settings={id}
      aria-busy={snapshot.status[id].applying}
      data-error={
        snapshot.error === "read" ||
          snapshot.status[id].error === "write"
          ? ""
          : undefined
      }
    >
      <label
        className="minke-local-model-switch"
        title={status}
      >
        <span className="minke-local-model-switch__label">
          {autoStart}
        </span>
        <Switch
          label={`${descriptor.displayName}: ${autoStart}`}
          title={status}
          checked={snapshot.settings[id].enabled}
          disabled={disabled}
          onChange={(enabled) => {
            try { runtime.setEnabled(id, enabled); }
            catch { /* The controlled switch retains the latest runtime state. */ }
          }}
        />
      </label>
      <span
        className="minke-local-model-switch__status"
        id={`minke-local-model-${id}-status`}
        aria-live="polite"
      >
        {status}
      </span>
    </span>
  );
}

function LocalModelServices({
  runtime,
  t,
}: LocalModelSlotInjected): ReactNode {
  const snapshot = useLocalModelSettings(runtime);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "hidden") void runtime.refreshStatus();
    };
    refresh();
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [runtime]);
  return (
    <section
      data-minke-local-model-runtime-settings=""
      className="minke-local-model-runtime-settings"
      aria-labelledby="minke-local-model-services-title"
    >
      <div className="minke-local-model-runtime-heading">
        <h3 id="minke-local-model-services-title">{t("servicesTitle")}</h3>
        <p>{t("servicesDescription")}</p>
      </div>
      <ul className="minke-local-model-runtime-list">
        {LOCAL_MODEL_RUNTIMES.map((descriptor) => (
          <li
            key={descriptor.id}
            data-minke-local-model-footer-row={descriptor.id}
            className="minke-local-model-row"
          >
            <span className="minke-local-model-row__identity">
              <span className="minke-local-model-row__heading">
                {descriptor.displayName}
                <span
                  className="minke-local-model-state"
                  data-state={snapshot.services[descriptor.id]}
                  role="status"
                  aria-label={`${descriptor.displayName}: ${t(snapshot.services[descriptor.id])}`}
                >
                  {t(snapshot.services[descriptor.id])}
                </span>
              </span>
              <span className="minke-local-model-row__note">
                {snapshot.available[descriptor.id]
                  ? t("serviceAvailable")
                  : t("commandNotFound")}
              </span>
            </span>
            <span className="minke-local-model-row__actions">
              <LocalModelRuntimeSwitch
                descriptor={descriptor}
                runtime={runtime}
                snapshot={snapshot}
                t={t}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Keep both local service lifecycle controls together in the Models footer,
 * independent of whether a provider currently has a discovered model catalog.
 */
export function installLocalModelSettings(
  slots: SlotService,
  runtime: LocalModelSettingsRuntime,
  t: LocalModelTranslate,
): () => void {
  const inject = () => ({ runtime, t });
  const disconnect = slots.inject(
    "settings.models.footer",
    () =>
      slots.register<LocalModelSlotInjected>(
        {
          name: "settings.models.footer",
          id: LOCAL_MODEL_FOOTER_ID,
          order: 0,
          inject,
        },
        LocalModelServices,
      ),
  );
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    disconnect();
  };
}
