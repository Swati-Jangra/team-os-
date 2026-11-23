/** Provider-neutral AI contracts. Nothing outside this package should import a vendor SDK. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Ask the model for a JSON object; callers must still validate the result. */
  json?: boolean;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  model: string;
  usage: Usage;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  /** Bump when the embedding model/normalisation changes: old chunks must be re-indexed. */
  version: string;
  dimensions: number;
  usage: Usage;
}

export interface TranscribeResult {
  text: string;
  model: string;
  durationSec?: number;
}

export interface AIProvider {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
  /** Speech-to-text. Absent on providers that cannot transcribe (the offline LocalProvider). */
  transcribe?(audio: Uint8Array, mime: string, filename: string, signal?: AbortSignal): Promise<TranscribeResult>;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult>;
}

/** Thrown for provider failures; `retryable` tells the worker whether BullMQ should retry. */
export class AIProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
