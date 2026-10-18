# Minke Model Runtime

`@lencx/minke-model-runtime` owns local model discovery, lifecycle, request preparation, and cleanup for Minke. Its core interface accepts a `ModelRuntimeHost`, so tests and non-Harness callers exercise the same module without Electron or Cordis.

The package exposes three interfaces:

- `@lencx/minke-model-runtime` — the host-neutral runtime core;
- `@lencx/minke-model-runtime/contract` — renderer-safe settings values and parsers shared across desktop processes;
- `@lencx/minke-model-runtime/dsh` — the DeepSeek Harness adapter composed by Minke's product overlay.

The DSH adapter translates `ctx.subprocess`, `ctx.credentials`, and the launch environment into the core host interface. It mounts the upstream `@deepseek-ai/dsh-llm-pi-ai` plugin before discovering local services in parallel, so saved cloud-provider settings are available without waiting for local startup. Discovered providers are published as a base layer without writing user settings. Local initialization failures are logged and leave cloud routes available; disposal waits for discovery and releases any owned processes.

Both LM Studio and Ollama use DSH's standard `LlmAdapter.resolveModel()` and
`prepareCall()` boundaries for live context metadata. A scoped Cordis context
wraps the native adapter at its public `registerAdapter()` entry point. Native
pi-ai still owns authentication, model settings, wire requests, stream parsing,
and registration cleanup. Capacity is resolved before DSH captures request
metadata or calculates compaction limits; the old `llm/stream` preparation hook
is retired. Settings changes cancel unfinished capacity lookups before dispatch; retrying
uses the new registration. Already prepared calls keep pi-ai's original
endpoint/credential snapshot.

Discovered LM Studio and Ollama routes use DSH's native
`retryPolicy: { mode: "normal", maxRetries: 0 }`. A terminated or overloaded local
engine fails the current turn without automatically replaying inference and
loading the model again. A subsequent human request may load it normally.
Explicit native provider profiles retain their configured retry policy, and
cloud and generic OpenAI-compatible provider defaults are unchanged.

The staged base composition mounts this adapter at the existing `llm-pi-ai`
Profile entry; an overlay patch's `name` only checks the module identity. Its
flat Config reuses the native provider schema, keeping volatile fields at fixed
paths. DSH owns settings migration, validation, and persistence; live provider
edits take precedence over local discovery without losing cloud routes.
The owning entry runs the native adapter's validation before a settings write.
Desktop startup migrates old model-entry name guards in both user Profile layers,
keeping a one-time `.before-minke-model-runtime` backup beside each changed patch.
Desktop launch preferences supply the local schema defaults. The command-line
product overlay must not set this entry's `config`, which would override the
profile and prevent native Models settings from being saved.

Requests wait only for updates to their own local service, and a cancelled request stops waiting immediately without cancelling the shared update. A running LM Studio or Ollama service with a valid empty model catalog counts as ready for auto-start acknowledgement; it does not publish an empty model provider.

LM Studio supports `external`, `ensure-running`, and `managed` lifecycles. Ollama supports `external` and `ensure-running`. Generic loopback OpenAI-compatible providers remain discovery-only and do not gain process ownership.

LM Studio discovery combines the OpenAI-compatible catalog with the native v1
model state, so installed LLM/VLM models remain selectable when Just-In-Time
loading is disabled and `/v1/models` lists only loaded instances. Embedding
models are excluded. Selecting a canonical model that LM Studio explicitly
reports with an empty, well-formed `loaded_instances` array authorizes Minke to
load that model using the service's defaults even under the `external`
lifecycle; the native state is read again before the request proceeds.
[LM Studio's loaded instance `config.context_length`](https://lmstudio.ai/docs/developer/rest/list)
is authoritative; the catalog's maximum context is not a loaded capacity.

Ollama reads each running model's `context_length` from
[`GET /api/ps`](https://docs.ollama.com/api/ps). If a selected, catalogued model is
not running, an empty-prompt `/api/generate` request loads it using Ollama's
defaults before reading its capacity again. Actual generation uses pi-ai's
standard OpenAI-compatible adapter. `:latest` aliases share a load queue.

Model information queries never load models. Call preparation serializes loads
for the same model, honors cancellation, and never unloads or resizes existing
instances. The local `lmStudio.defaultContextWindow` and
`ollama.defaultContextWindow` overrides are retired; change loading parameters
in the model service. Generic OpenAI-compatible providers and explicitly saved
native provider profiles retain their native context configuration.

Missing or ambiguous loaded-instance capacity is reported as unknown, and call
preparation rejects rather than reloading that instance. Unsupported or
unavailable native metadata APIs preserve OpenAI-compatible access with unknown
capacity; they never restore a cached or theoretical maximum. Explicit saved
profiles take precedence and do not probe Minke's local service endpoint.
