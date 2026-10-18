import {
  LlmAdapter,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
} from "@deepseek-ai/dsh-llm";
import type { ModelRuntimeContext, ModelRuntimeRequest } from "./core.ts";

export type CaptureModelContext = <T>(
  request: ModelRuntimeRequest,
  capture: () => Promise<T>,
) => Promise<{ value: T; context: ModelRuntimeContext | void }>;

function withContext(model: LlmResolvedModelInfo, context: ModelRuntimeContext | void): LlmResolvedModelInfo {
  if (context === undefined) return model;
  const { context: _catalogContext, ...metadata } = model;
  return context.contextWindow === undefined ? metadata
    : { ...metadata, context: { contextWindow: context.contextWindow } };
}

/** Add live capacity at the standard metadata boundary; pi-ai owns dispatch. */
export class ModelContextAdapter extends LlmAdapter {
  private readonly native: LlmAdapter;
  private readonly capture: CaptureModelContext;

  constructor(native: LlmAdapter, capture: CaptureModelContext) {
    super();
    this.native = native;
    this.capture = capture;
  }

  override providerInfo(...args: Parameters<LlmAdapter["providerInfo"]>) {
    return this.native.providerInfo(...args);
  }

  override providerRetryPolicy(...args: Parameters<LlmAdapter["providerRetryPolicy"]>) {
    return this.native.providerRetryPolicy(...args);
  }

  override imageRequestPricing(...args: Parameters<LlmAdapter["imageRequestPricing"]>) {
    return this.native.imageRequestPricing(...args);
  }

  override imageRequestTarget(...args: Parameters<LlmAdapter["imageRequestTarget"]>) {
    return this.native.imageRequestTarget(...args);
  }

  override listModels(...args: Parameters<LlmAdapter["listModels"]>) {
    return this.native.listModels(...args);
  }

  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const captured = await this.capture({ provider, model, ...(signal === undefined ? {} : { signal }), load: false },
      () => this.native.resolveModel(provider, model, signal));
    return withContext(captured.value, captured.context);
  }

  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const captured = await this.capture({ provider, model, ...(signal === undefined ? {} : { signal }), load: true },
      () => this.native.prepareCall(provider, model, signal));
    return {
      model: withContext(captured.value.model, captured.context),
      stream: options => captured.value.stream(options),
    };
  }

  override stream(...args: Parameters<LlmAdapter["stream"]>) {
    return this.native.stream(...args);
  }
}
