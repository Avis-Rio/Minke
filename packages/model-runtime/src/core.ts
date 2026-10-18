/**
 * Local model discovery, lifecycle, request preparation, and cleanup.
 * @module @lencx/minke-model-runtime
 */
const DEFAULT_LM_STUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434/v1";
const MODEL_REQUEST_TIMEOUT_MS = 1_500;
const MODEL_LOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const CLI_STATUS_TIMEOUT_MS = 2_000;
const CLI_LIFECYCLE_TIMEOUT_MS = 60_000;
const STARTUP_ATTEMPTS = 8;
const STARTUP_RETRY_DELAY_MS = 250;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LOCAL_AUTHORIZATION = "Bearer local-model";

export type ServiceLifecycle = "external" | "ensure-running" | "managed";
export type ModelInput = "text" | "image";
export type LogLevel = "info" | "warn";

export interface ModelProfile {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: ModelInput[];
}

export interface ProviderProfile {
  displayName: string;
  api: "openai-completions";
  baseURL: string;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
  defaultInput: ["text"];
  models: ModelProfile[];
  apiKeyEnv?: string;
  headers?: Record<string, string>;
}

export interface CommandResult {
  executable: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningCommand {
  readonly done: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>;
  terminate(): void;
}

export interface ModelRuntimeHost {
  localRuntimeCommands: {
    lmStudio: readonly string[];
    ollama: readonly string[];
  };
  run(
    candidates: readonly string[],
    args: readonly string[],
    timeoutMs: number,
  ): Promise<CommandResult | undefined>;
  start(
    candidates: readonly string[],
    args: readonly string[],
    environment?: Readonly<Record<string, string>>,
  ): Promise<RunningCommand | undefined>;
  fetch: typeof globalThis.fetch;
  resolveCredential(ref: string): Promise<string | undefined>;
  sleep(ms: number): Promise<void>;
  log(level: LogLevel, message: string): void;
}

export interface LmStudioRuntimeConfig {
  enabled?: boolean;
  lifecycle?: ServiceLifecycle;
  baseURL?: string;
  command?: string;
  apiKeyEnv?: string;
  defaultMaxTokens?: number;
}

export interface OpenAICompatibleRuntimeConfig {
  id: string;
  enabled?: boolean;
  displayName?: string;
  baseURL: string;
  apiKeyEnv?: string;
  defaultContextWindow?: number;
  defaultMaxTokens?: number;
}

export interface OllamaRuntimeConfig {
  enabled?: boolean;
  lifecycle?: Exclude<ServiceLifecycle, "managed">;
  baseURL?: string;
  command?: string;
  defaultMaxTokens?: number;
}

export interface ModelRuntimeConfig {
  lmStudio?: LmStudioRuntimeConfig;
  ollama?: OllamaRuntimeConfig;
  openAICompatible?: OpenAICompatibleRuntimeConfig[];
}

export interface PreparedModelRuntime {
  providers: Record<string, ProviderProfile>;
  /** Reachable services, including ones whose model catalog is still empty. */
  servicesReady?: readonly string[];
  prepareRequest(request: ModelRuntimeRequest): Promise<ModelRuntimeContext | void>;
  dispose(): Promise<void>;
}

/** Live instance capacity; an empty object means it could not be confirmed. */
export interface ModelRuntimeContext {
  contextWindow?: number;
}

export interface ModelRuntimeRequest {
  provider: string;
  model: string;
  signal?: AbortSignal;
  /** Metadata queries never load models. Actual call preparation may load one. */
  load?: boolean;
}

export class ModelRuntimeRequestError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelRuntimeRequestError";
    this.code = code;
  }
}

interface ModelListingEntry {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  context_window?: unknown;
  context_length?: unknown;
  max_context_length?: unknown;
  max_tokens?: unknown;
}

interface LmStudioStatus {
  running: boolean;
  port?: number;
}

interface LmStudioLoadedInstance {
  id: string;
  contextLength: number;
}

interface LmStudioModelState {
  key: string;
  modelType?: string;
  displayName?: string;
  loadedInstances: LmStudioLoadedInstance[];
  loadedInstancesComplete: boolean;
}

interface PreparedAdapter {
  provider?: ProviderProfile;
  serviceReady?: boolean;
  prepareRequest?(request: ModelRuntimeRequest): Promise<ModelRuntimeContext | void>;
  dispose(): Promise<void>;
}

interface ModelRuntimeAdapter {
  readonly providerId: string;
  prepare(host: ModelRuntimeHost): Promise<PreparedAdapter>;
}

function nonEmptyText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (normalized !== "") return normalized;
  }
  return undefined;
}

function positiveInteger(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value > 0
    ) {
      return value;
    }
  }
  return undefined;
}

function providerId(value: string): string {
  if (value === "" || value.trim() !== value) {
    throw new Error(
      "model-runtime: provider ids must be non-empty and have no surrounding whitespace",
    );
  }
  return value;
}

function unique<T>(values: readonly T[]): T[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

/** Normalize one local OpenAI-compatible endpoint without accepting remote URLs. */
export function resolveLocalOpenAIBaseURL(value: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.port === "0"
  ) {
    throw new Error(
      "model-runtime: local model base URL must be an unauthenticated loopback HTTP URL with a connectable port",
    );
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = pathname === "" || pathname === "/" ? "/v1" : pathname;
  return url.toString().replace(/\/$/u, "");
}

function localServiceAddress(baseURL: string): {
  bind: string;
  authority: string;
  port: number;
} {
  const url = new URL(baseURL);
  const port = url.port === "" ? 80 : Number(url.port);
  const bind =
    url.hostname === "localhost"
      ? "127.0.0.1"
      : url.hostname.replace(/^\[(.*)\]$/u, "$1");
  return {
    bind,
    authority: `${url.hostname}:${String(port)}`,
    port,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    throw new Error(`model endpoint answered HTTP ${String(response.status)}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("model endpoint listing is too large");
  }
  if (response.body === null) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error("model endpoint listing is too large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

interface JsonRequestOptions {
  method?: "GET" | "POST";
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function requestJson(
  host: ModelRuntimeHost,
  url: string,
  token: string | undefined,
  options: JsonRequestOptions = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS,
  );
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([options.signal, controller.signal]);
  try {
    const response = await host.fetch(url, {
      method: options.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(token === undefined
          ? {}
          : { authorization: `Bearer ${token}` }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
      signal,
    });
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchListing(
  host: ModelRuntimeHost,
  url: string,
  token: string | undefined,
): Promise<ModelListingEntry[] | undefined> {
  try {
    const value = await requestJson(host, url, token);
    const listing = objectRecord(value);
    const data = listing?.data;
    // Ollama serializes an empty OpenAI model list as null instead of [].
    if (listing?.object === "list" && data === null) return [];
    return Array.isArray(data)
      ? data.filter(
          (entry): entry is ModelListingEntry =>
            typeof entry === "object" &&
            entry !== null &&
            !Array.isArray(entry),
        )
      : undefined;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseLmStudioModelStates(
  value: unknown,
): LmStudioModelState[] | undefined {
  const models = objectRecord(value)?.models;
  if (!Array.isArray(models)) return undefined;
  const states: LmStudioModelState[] = [];
  for (const value of models) {
    const model = objectRecord(value);
    const key = nonEmptyText(model?.key);
    if (model === undefined || key === undefined) continue;
    const loaded = model.loaded_instances;
    let loadedInstancesComplete = Array.isArray(loaded);
    const loadedInstances: LmStudioLoadedInstance[] = [];
    for (const value of Array.isArray(loaded) ? loaded : []) {
      const instance = objectRecord(value);
      const config = objectRecord(instance?.config);
      const id = nonEmptyText(instance?.id);
      const contextLength = positiveInteger(config?.context_length);
      if (
        instance === undefined ||
        config === undefined ||
        id === undefined ||
        contextLength === undefined
      ) {
        loadedInstancesComplete = false;
        continue;
      }
      loadedInstances.push({ id, contextLength });
    }
    const modelType = nonEmptyText(model.type)?.toLowerCase();
    const displayName = nonEmptyText(model.display_name, model.name);
    states.push({
      key,
      ...(modelType === undefined ? {} : { modelType }),
      ...(displayName === undefined ? {} : { displayName }),
      loadedInstances,
      loadedInstancesComplete,
    });
  }
  return states;
}

async function fetchLmStudioModelStates(
  host: ModelRuntimeHost,
  origin: string,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<LmStudioModelState[] | undefined> {
  try {
    return parseLmStudioModelStates(
      await requestJson(
        host,
        `${origin}/api/v1/models`,
        token,
        signal === undefined ? {} : { signal },
      ),
    );
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

function lmStudioStateForModel(
  states: readonly LmStudioModelState[],
  model: string,
): {
  state: LmStudioModelState;
  instance?: LmStudioLoadedInstance;
} | undefined {
  const keyed = states.find((state) => state.key === model);
  const hosting = keyed ??
    states.find((state) =>
      state.loadedInstances.some((instance) => instance.id === model)
    );
  if (hosting === undefined) return undefined;
  const exact = hosting.loadedInstances.find(
    (instance) => instance.id === model,
  );
  if (exact !== undefined) return { state: hosting, instance: exact };
  const onlyInstance = hosting.loadedInstances.length === 1
    ? hosting.loadedInstances[0]
    : undefined;
  if (hosting.key === model && onlyInstance !== undefined) {
    return {
      state: hosting,
      instance: onlyInstance,
    };
  }
  return { state: hosting };
}

async function loadLmStudioModel(
  host: ModelRuntimeHost,
  origin: string,
  token: string | undefined,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  return await requestJson(
    host,
    `${origin}/api/v1/models/load`,
    token,
    {
      method: "POST",
      body,
      ...(signal === undefined ? {} : { signal }),
      timeoutMs: MODEL_LOAD_TIMEOUT_MS,
    },
  );
}

function isLmStudioGenerativeModel(state: LmStudioModelState): boolean {
  return state.modelType === "llm" || state.modelType === "vlm";
}

function unsafeLmStudioModelStateError(
  model: string,
): ModelRuntimeRequestError {
  return new ModelRuntimeRequestError(
    `LM Studio did not report model "${model}" as a single, explicitly unloaded `
      + "LLM or VLM. Minke left LM Studio untouched. Update LM Studio or load the "
      + "model manually, then retry.",
    "LM_STUDIO_CONTEXT_STATE_UNSAFE",
  );
}

/** Read effective capacity on every lookup; only call preparation may load. */
class LmStudioModelContext {
  private readonly pending = new Map<string, Promise<ModelRuntimeContext>>();
  private readonly host: ModelRuntimeHost;
  private readonly origin: string;
  private readonly token: string | undefined;

  constructor(
    host: ModelRuntimeHost,
    origin: string,
    token: string | undefined,
  ) {
    this.host = host;
    this.origin = origin;
    this.token = token;
  }

  async prepare(request: ModelRuntimeRequest): Promise<ModelRuntimeContext> {
    request.signal?.throwIfAborted();
    if (request.load === false) return this.resolve(request);
    const prior = this.pending.get(request.model) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(() => this.resolve(request));
    this.pending.set(request.model, operation);
    try {
      return await operation;
    } finally {
      if (this.pending.get(request.model) === operation) this.pending.delete(request.model);
    }
  }

  private async resolve(request: ModelRuntimeRequest): Promise<ModelRuntimeContext> {
    const { model, signal } = request;
    signal?.throwIfAborted();
    const states = await fetchLmStudioModelStates(this.host, this.origin, this.token, signal);
    // Older services can still generate, but a catalog limit is not evidence
    // of loaded capacity. Never turn an unavailable lookup into a stale value.
    if (states === undefined) return {};
    const resolved = lmStudioStateForModel(states, model);
    if (resolved?.state.loadedInstancesComplete && resolved.instance !== undefined) {
      return { contextWindow: resolved.instance.contextLength };
    }
    if (request.load === false) return {};
    if (resolved === undefined || resolved.state.key !== model ||
        !isLmStudioGenerativeModel(resolved.state) ||
        !resolved.state.loadedInstancesComplete || resolved.state.loadedInstances.length !== 0) {
      throw unsafeLmStudioModelStateError(model);
    }
    // Loading uses LM Studio's own defaults; never resize an existing instance.
    try {
      await loadLmStudioModel(this.host, this.origin, this.token, {
        model,
        echo_load_config: true,
      }, signal);
      const confirmed = await fetchLmStudioModelStates(this.host, this.origin, this.token, signal);
      const loaded = confirmed === undefined ? undefined : lmStudioStateForModel(confirmed, model);
      if (loaded?.state.loadedInstancesComplete && loaded.instance !== undefined) {
        return { contextWindow: loaded.instance.contextLength };
      }
      throw new Error("LM Studio did not confirm the loaded context");
    } catch (error) {
      signal?.throwIfAborted();
      throw new ModelRuntimeRequestError(
        `Minke could not confirm the loaded context of LM Studio model "${model}". `
          + "Load the model in LM Studio and retry.",
        "LM_STUDIO_CONTEXT_PREPARATION_FAILED",
        { cause: error },
      );
    }
  }
}

function modelProfile(
  entry: ModelListingEntry,
  metadata?: ModelListingEntry,
): ModelProfile | undefined {
  const id = nonEmptyText(entry.id, metadata?.id);
  if (id === undefined) return undefined;
  const type = nonEmptyText(metadata?.type, entry.type)?.toLowerCase();
  if (type === "embedding" || type === "embeddings") return undefined;
  const name = nonEmptyText(
    metadata?.display_name,
    metadata?.name,
    entry.display_name,
    entry.name,
  );
  const contextWindow = positiveInteger(
    metadata?.max_context_length,
    metadata?.context_window,
    metadata?.context_length,
    entry.max_context_length,
    entry.context_window,
    entry.context_length,
  );
  const maxTokens = positiveInteger(metadata?.max_tokens, entry.max_tokens);
  return {
    id,
    ...(name === undefined || name === id ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(type === "vlm" ? { input: ["text", "image"] as ModelInput[] } : {}),
  };
}

function lmStudioStateListingEntry(
  state: LmStudioModelState,
): ModelListingEntry {
  return {
    id: state.key,
    ...(state.modelType === undefined ? {} : { type: state.modelType }),
    ...(state.displayName === undefined
      ? {}
      : { display_name: state.displayName }),
  };
}

function lmStudioListingMetadata(
  state: LmStudioModelState | undefined,
  detailed: ModelListingEntry | undefined,
): ModelListingEntry | undefined {
  if (state === undefined) return detailed;
  const native = lmStudioStateListingEntry(state);
  if (detailed === undefined) return native;
  const type = nonEmptyText(detailed.type, native.type);
  return {
    ...native,
    ...detailed,
    ...(type === undefined ? {} : { type }),
  };
}

function mergeLmStudioListings(
  openAI: ModelListingEntry[] | undefined,
  detailed: ModelListingEntry[] | undefined,
  states: readonly LmStudioModelState[] | undefined,
): ModelProfile[] {
  if (openAI === undefined && states === undefined) return [];
  const detailedById = new Map<string, ModelListingEntry>();
  for (const entry of detailed ?? []) {
    const id = nonEmptyText(entry.id);
    if (id !== undefined) detailedById.set(id, entry);
  }
  const stateById = new Map(
    (states ?? []).map((state) => [state.key, state] as const),
  );

  const models = new Map<string, ModelProfile>();
  for (const entry of openAI ?? []) {
    const id = nonEmptyText(entry.id);
    const state = id === undefined ? undefined : stateById.get(id);
    const profile = modelProfile(
      entry,
      id === undefined
        ? undefined
        : lmStudioListingMetadata(state, detailedById.get(id)),
    );
    if (profile !== undefined && !models.has(profile.id)) {
      models.set(profile.id, profile);
    }
  }
  for (const state of states ?? []) {
    if (!isLmStudioGenerativeModel(state)) continue;
    const profile = modelProfile(
      lmStudioStateListingEntry(state),
      lmStudioListingMetadata(state, detailedById.get(state.key)),
    );
    if (profile !== undefined && !models.has(profile.id)) {
      models.set(profile.id, profile);
    }
  }
  return [...models.values()];
}

function effectiveLmStudioContext(
  profile: ModelProfile,
  states: readonly LmStudioModelState[] | undefined,
): ModelProfile {
  const { contextWindow: _catalogCapacity, ...withoutContext } = profile;
  const resolved = states === undefined ? undefined : lmStudioStateForModel(states, profile.id);
  return resolved?.state.loadedInstancesComplete && resolved.instance !== undefined
    ? { ...withoutContext, contextWindow: resolved.instance.contextLength }
    : withoutContext;
}

async function discoverLmStudioModels(
  host: ModelRuntimeHost,
  baseURL: string,
  token: string | undefined,
): Promise<ModelProfile[] | undefined> {
  const endpoint = new URL(baseURL);
  const [openAI, detailed, states] = await Promise.all([
    fetchListing(host, `${baseURL}/models`, token),
    fetchListing(host, `${endpoint.origin}/api/v0/models`, token),
    fetchLmStudioModelStates(host, endpoint.origin, token),
  ]);
  // A valid empty catalog proves readiness just as a populated one does.
  // The optional v0 metadata endpoint alone cannot establish a usable API.
  if (openAI === undefined && states === undefined) return undefined;
  return mergeLmStudioListings(openAI, detailed, states).map((profile) =>
    effectiveLmStudioContext(profile, states)
  );
}

async function discoverOpenAIModels(
  host: ModelRuntimeHost,
  baseURL: string,
  token: string | undefined,
): Promise<ModelProfile[] | undefined> {
  const listing = await fetchListing(host, `${baseURL}/models`, token);
  if (listing === undefined) return undefined;
  const models = new Map<string, ModelProfile>();
  for (const entry of listing) {
    const profile = modelProfile(entry);
    if (profile !== undefined && !models.has(profile.id)) {
      models.set(profile.id, profile);
    }
  }
  return [...models.values()];
}

function parseLmStudioStatus(result: CommandResult | undefined):
  | LmStudioStatus
  | undefined {
  if (result?.exitCode !== 0) return undefined;
  try {
    const value = JSON.parse(result.stdout) as {
      running?: unknown;
      port?: unknown;
    };
    if (typeof value.running !== "boolean") return undefined;
    const port =
      typeof value.port === "number" &&
      Number.isSafeInteger(value.port) &&
      value.port >= 1 &&
      value.port <= 65_535
        ? value.port
        : undefined;
    return {
      running: value.running,
      ...(port === undefined ? {} : { port }),
    };
  } catch {
    return undefined;
  }
}

function authProfile(
  apiKeyEnv: string | undefined,
  token: string | undefined,
  apiKeyWasExplicit: boolean,
): Pick<ProviderProfile, "apiKeyEnv" | "headers"> {
  if (apiKeyEnv !== undefined && (token !== undefined || apiKeyWasExplicit)) {
    return { apiKeyEnv };
  }
  return { headers: { Authorization: LOCAL_AUTHORIZATION } };
}

function providerProfile(
  displayName: string,
  baseURL: string,
  models: ModelProfile[],
  defaultContextWindow: number | undefined,
  defaultMaxTokens: number | undefined,
  auth: Pick<ProviderProfile, "apiKeyEnv" | "headers">,
): ProviderProfile {
  const contextWindow = positiveInteger(defaultContextWindow);
  const maxTokens = positiveInteger(defaultMaxTokens);
  return {
    displayName,
    api: "openai-completions",
    baseURL,
    ...(contextWindow === undefined
      ? {}
      : { defaultContextWindow: contextWindow }),
    ...(maxTokens === undefined ? {} : { defaultMaxTokens: maxTokens }),
    defaultInput: ["text"],
    models,
    ...auth,
  };
}

class LmStudioAdapter implements ModelRuntimeAdapter {
  readonly providerId = "lm-studio";
  private readonly config: LmStudioRuntimeConfig;

  constructor(config: LmStudioRuntimeConfig) {
    this.config = config;
  }

  async prepare(host: ModelRuntimeHost): Promise<PreparedAdapter> {
    const lifecycle = this.config.lifecycle ?? "external";
    const commands = unique([
      ...(nonEmptyText(this.config.command) === undefined
        ? []
        : [nonEmptyText(this.config.command) as string]),
      ...host.localRuntimeCommands.lmStudio,
    ]);
    const configuredBaseURL = nonEmptyText(this.config.baseURL);
    const explicitBaseURL =
      configuredBaseURL === undefined
        ? undefined
        : resolveLocalOpenAIBaseURL(configuredBaseURL);
    const explicitApiKeyEnv = nonEmptyText(this.config.apiKeyEnv);
    const apiKeyEnv = explicitApiKeyEnv ?? "LM_API_TOKEN";
    const token = await host.resolveCredential(apiKeyEnv);
    const auth = authProfile(
      apiKeyEnv,
      nonEmptyText(token),
      explicitApiKeyEnv !== undefined,
    );
    const readStatus = async (): Promise<LmStudioStatus | undefined> =>
      parseLmStudioStatus(
        await host.run(
          commands,
          ["server", "status", "--json"],
          CLI_STATUS_TIMEOUT_MS,
        ),
      );
    const candidates = (status: LmStudioStatus | undefined): string[] =>
      explicitBaseURL === undefined
        ? unique([
            ...(status?.running === true && status.port !== undefined
              ? [`http://127.0.0.1:${String(status.port)}/v1`]
              : []),
            DEFAULT_LM_STUDIO_BASE_URL,
          ])
        : [explicitBaseURL];
    const probe = async (
      status: LmStudioStatus | undefined,
    ): Promise<{ baseURL: string; models: ModelProfile[] } | undefined> => {
      const discovered = await Promise.all(
        candidates(status).map(async (baseURL) => {
          const models = await discoverLmStudioModels(
            host,
            baseURL,
            nonEmptyText(token),
          );
          return models === undefined ? undefined : { baseURL, models };
        }),
      );
      return discovered.find((entry) => entry !== undefined && entry.models.length > 0)
        ?? discovered.find((entry) => entry !== undefined);
    };
    const preparedProvider = (
      selected: { baseURL: string; models: ModelProfile[] },
      dispose: () => Promise<void>,
    ): PreparedAdapter => {
      if (selected.models.length === 0) {
        return { serviceReady: true, dispose };
      }
      const modelContext = new LmStudioModelContext(
        host, new URL(selected.baseURL).origin, nonEmptyText(token),
      );
      return {
        provider: providerProfile(
          "LM Studio",
          selected.baseURL,
          selected.models,
          undefined,
          this.config.defaultMaxTokens,
          auth,
        ),
        prepareRequest: request => modelContext.prepare(request),
        dispose,
      };
    };

    const beforeStart = await readStatus();
    let selected = await probe(beforeStart);
    if (selected !== undefined) {
      return preparedProvider(selected, async () => {});
    }
    if (lifecycle === "external") {
      host.log(
        "info",
        "model-runtime: LM Studio is unavailable; external lifecycle leaves it untouched",
      );
      return { dispose: async () => {} };
    }

    const explicitAddress =
      explicitBaseURL === undefined
        ? undefined
        : localServiceAddress(explicitBaseURL);
    const start = await host.run(
      commands,
      [
        "server",
        "start",
        ...(explicitAddress === undefined
          ? []
          : [
              "--port",
              String(explicitAddress.port),
              "--bind",
              explicitAddress.bind,
            ]),
      ],
      CLI_LIFECYCLE_TIMEOUT_MS,
    );
    if (start === undefined) {
      host.log(
        "info",
        "model-runtime: LM Studio CLI is unavailable; skipping the optional runtime",
      );
      return { dispose: async () => {} };
    }
    const ownsService = beforeStart?.running === false && start.exitCode === 0;
    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await host.sleep(STARTUP_RETRY_DELAY_MS);
      selected = await probe(await readStatus());
      if (selected !== undefined) break;
    }

    const stopOwnedService = async (): Promise<void> => {
      if (lifecycle !== "managed" || !ownsService) return;
      const stopped = await host.run(
        commands,
        ["server", "stop"],
        CLI_LIFECYCLE_TIMEOUT_MS,
      );
      if (stopped?.exitCode !== 0) {
        host.log(
          "warn",
          "model-runtime: LM Studio was started by this plugin but could not be stopped cleanly",
        );
      }
    };

    if (selected === undefined) {
      host.log(
        "warn",
        "model-runtime: LM Studio did not expose an OpenAI-compatible model after startup",
      );
      await stopOwnedService();
      return { dispose: async () => {} };
    }
    return preparedProvider(selected, stopOwnedService);
  }
}

function ollamaModelName(model: string): string {
  // A tag belongs to the final path component; a registry port is not a tag.
  return model.slice(model.lastIndexOf("/") + 1).includes(":") ? model : `${model}:latest`;
}

/** Ollama's catalog describes trained capacity; /api/ps describes the runner. */
function ollamaContextPreparer(
  host: ModelRuntimeHost,
  baseURL: string,
  models: readonly ModelProfile[],
): (request: ModelRuntimeRequest) => Promise<ModelRuntimeContext> {
  const origin = new URL(baseURL).origin;
  const known = new Set(models.map(model => ollamaModelName(model.id)));
  const pending = new Map<string, Promise<ModelRuntimeContext>>();
  const read = async (signal?: AbortSignal): Promise<unknown[] | undefined> => {
    try {
      const value = objectRecord(await requestJson(host, `${origin}/api/ps`, undefined, signal === undefined ? {} : { signal }));
      return Array.isArray(value?.models) ? value.models : undefined;
    } catch {
      signal?.throwIfAborted();
      return undefined;
    }
  };
  const matches = (rows: unknown[], model: string): Record<string, unknown>[] => rows
    .map(objectRecord)
    .filter((row): row is Record<string, unknown> => row !== undefined &&
      [row.name, row.model].some(name => typeof name === "string" && ollamaModelName(name) === ollamaModelName(model)));
  const resolve = async ({ model, signal, load }: ModelRuntimeRequest): Promise<ModelRuntimeContext> => {
    signal?.throwIfAborted();
    const rows = await read(signal);
    if (rows === undefined) return {};
    const loaded = matches(rows, model);
    const contextWindow = loaded.length === 1 ? positiveInteger(loaded[0]?.context_length) : undefined;
    if (contextWindow !== undefined) return { contextWindow };
    if (load === false) return {};
    // Missing capacity on an existing runner must not cause it to be reloaded.
    if (loaded.length > 0 || !known.has(ollamaModelName(model)) || rows.some(row => {
      const record = objectRecord(row);
      return nonEmptyText(record?.name, record?.model) === undefined;
    })) {
      throw new ModelRuntimeRequestError(
        `Ollama did not report a unique loaded context for model "${model}". Check the model in Ollama and retry.`,
        "OLLAMA_CONTEXT_UNKNOWN",
      );
    }
    try {
      // An empty prompt is Ollama's documented load-only operation. Prompts,
      // tools and actual generation still go through DSH's native pi-ai adapter.
      await requestJson(host, `${origin}/api/generate`, undefined, {
        method: "POST",
        body: { model, prompt: "", stream: false },
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: MODEL_LOAD_TIMEOUT_MS,
      });
      const confirmed = await read(signal);
      const instances = confirmed === undefined ? [] : matches(confirmed, model);
      const actual = instances.length === 1 ? positiveInteger(instances[0]?.context_length) : undefined;
      if (actual !== undefined) return { contextWindow: actual };
      throw new Error("Ollama did not confirm the loaded context");
    } catch (error) {
      signal?.throwIfAborted();
      throw new ModelRuntimeRequestError(
        `Minke could not confirm the loaded context of Ollama model "${model}". Load the model in Ollama and retry.`,
        "OLLAMA_CONTEXT_PREPARATION_FAILED",
        { cause: error },
      );
    }
  };
  return async request => {
    request.signal?.throwIfAborted();
    if (request.load === false) return resolve(request);
    const key = ollamaModelName(request.model);
    const operation = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => resolve(request));
    pending.set(key, operation);
    try {
      return await operation;
    } finally {
      if (pending.get(key) === operation) pending.delete(key);
    }
  };
}

class OllamaAdapter implements ModelRuntimeAdapter {
  readonly providerId = "ollama";
  private readonly config: OllamaRuntimeConfig;

  constructor(config: OllamaRuntimeConfig) {
    this.config = config;
  }

  async prepare(host: ModelRuntimeHost): Promise<PreparedAdapter> {
    const lifecycle = this.config.lifecycle ?? "external";
    const commands = unique([
      ...(nonEmptyText(this.config.command) === undefined
        ? []
        : [nonEmptyText(this.config.command) as string]),
      ...host.localRuntimeCommands.ollama,
    ]);
    const configuredBaseURL = nonEmptyText(this.config.baseURL);
    const baseURL = configuredBaseURL === undefined
      ? DEFAULT_OLLAMA_BASE_URL
      : resolveLocalOpenAIBaseURL(configuredBaseURL);
    const auth = authProfile(undefined, undefined, false);
    const profile = (models: ModelProfile[]): ProviderProfile =>
      providerProfile(
        "Ollama",
        baseURL,
        models.map(({ contextWindow: _catalogCapacity, ...model }) => model),
        undefined,
        this.config.defaultMaxTokens,
        auth,
      );
    const discover = async (): Promise<ModelProfile[] | undefined> =>
      await discoverOpenAIModels(host, baseURL, undefined);
    const preparedProvider = (models: ModelProfile[], dispose: () => Promise<void>): PreparedAdapter => ({
      serviceReady: true,
      ...(models.length > 0 ? {
        provider: profile(models),
        prepareRequest: ollamaContextPreparer(host, baseURL, models),
      } : {}),
      dispose,
    });

    let models = await discover();
    if (models !== undefined) {
      return preparedProvider(models, async () => {});
    }
    if (lifecycle === "external") {
      host.log(
        "info",
        "model-runtime: Ollama is unavailable; external lifecycle leaves it untouched",
      );
      return { dispose: async () => {} };
    }

    const address = localServiceAddress(baseURL);
    const server = await host.start(
      commands,
      ["serve"],
      {
        OLLAMA_HOST: address.authority,
      },
    );
    if (server === undefined) {
      host.log(
        "info",
        "model-runtime: Ollama CLI is unavailable; skipping auto-start",
      );
      return { dispose: async () => {} };
    }
    void server.done.catch((error: unknown) => {
      host.log(
        "warn",
        `model-runtime: owned Ollama server exited unexpectedly: ${String(error)}`,
      );
    });
    for (let attempt = 0; attempt < STARTUP_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await host.sleep(STARTUP_RETRY_DELAY_MS);
      models = await discover();
      if (models !== undefined) break;
    }

    let disposed = false;
    const stopOwnedServer = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      server.terminate();
      await server.done.catch(() => undefined);
    };
    if (models === undefined) {
      host.log(
        "warn",
        "model-runtime: Ollama did not expose a valid model catalog after startup",
      );
      return {
        dispose: stopOwnedServer,
      };
    }
    return preparedProvider(models, stopOwnedServer);
  }
}

class OpenAICompatibleAdapter implements ModelRuntimeAdapter {
  readonly providerId: string;
  private readonly config: OpenAICompatibleRuntimeConfig;

  constructor(config: OpenAICompatibleRuntimeConfig) {
    this.config = config;
    this.providerId = providerId(config.id);
  }

  async prepare(host: ModelRuntimeHost): Promise<PreparedAdapter> {
    const baseURL = resolveLocalOpenAIBaseURL(this.config.baseURL);
    const apiKeyEnv = nonEmptyText(this.config.apiKeyEnv);
    const token =
      apiKeyEnv === undefined
        ? undefined
        : nonEmptyText(await host.resolveCredential(apiKeyEnv));
    const models = await discoverOpenAIModels(host, baseURL, token) ?? [];
    if (models.length === 0) {
      host.log(
        "info",
        `model-runtime: local provider "${this.providerId}" is unavailable`,
      );
      return { dispose: async () => {} };
    }
    return {
      provider: providerProfile(
        nonEmptyText(this.config.displayName) ?? this.providerId,
        baseURL,
        models,
        this.config.defaultContextWindow,
        this.config.defaultMaxTokens,
        authProfile(apiKeyEnv, token, apiKeyEnv !== undefined),
      ),
      dispose: async () => {},
    };
  }
}

/**
 * Prepare configured local runtimes and return provider metadata plus owned
 * lifecycle cleanup. Runtime state remains ephemeral and is never persisted as
 * user settings.
 */
export async function prepareModelRuntime(
  config: ModelRuntimeConfig,
  host: ModelRuntimeHost,
): Promise<PreparedModelRuntime> {
  const adapters: ModelRuntimeAdapter[] = [];
  if (config.lmStudio?.enabled === true) {
    adapters.push(new LmStudioAdapter(config.lmStudio));
  }
  if (config.ollama?.enabled === true) {
    adapters.push(new OllamaAdapter(config.ollama));
  }
  for (const endpoint of config.openAICompatible ?? []) {
    if (endpoint.enabled !== false) {
      adapters.push(new OpenAICompatibleAdapter(endpoint));
    }
  }

  const configuredIds = new Set<string>();
  for (const adapter of adapters) {
    if (configuredIds.has(adapter.providerId)) {
      throw new Error(
        `model-runtime: duplicate provider id "${adapter.providerId}"`,
      );
    }
    configuredIds.add(adapter.providerId);
  }

  const prepared: PreparedAdapter[] = [];
  try {
    for (const adapter of adapters) {
      prepared.push(await adapter.prepare(host));
    }
  } catch (error) {
    await Promise.allSettled(
      prepared.reverse().map(async (entry) => entry.dispose()),
    );
    throw error;
  }

  const providers = Object.fromEntries(
    adapters.flatMap((adapter, index) => {
      const provider = prepared[index]?.provider;
      return provider === undefined
        ? []
        : [[adapter.providerId, provider] as const];
    }),
  );
  const requests = new Map(
    adapters.flatMap((adapter, index) => {
      const prepareRequest = prepared[index]?.prepareRequest;
      return prepareRequest === undefined
        ? []
        : [[adapter.providerId, prepareRequest] as const];
    }),
  );
  let disposed = false;
  return {
    providers,
    servicesReady: adapters.flatMap((adapter, index) =>
      prepared[index]?.serviceReady === true ||
        prepared[index]?.provider !== undefined
        ? [adapter.providerId]
        : []
    ),
    prepareRequest: async (request) => {
      return await requests.get(request.provider)?.(request);
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      const outcomes = await Promise.allSettled(
        prepared.reverse().map(async (entry) => entry.dispose()),
      );
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "model-runtime: multiple service cleanup operations failed",
        );
      }
    },
  };
}
