import { AIProviderError, type AIProvider, type ChatRequest, type ChatResult, type EmbedResult, type TranscribeResult } from './types';

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  chatModel?: string;
  embeddingModel?: string;
  embeddingDimensions?: number;
  transcriptionModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** OpenAI-compatible HTTP provider (works with OpenAI and compatible gateways). The API key is never logged. */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';
  private readonly o: Required<Omit<OpenAIOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(opts: OpenAIOptions) {
    if (!opts.apiKey) throw new Error('OpenAIProvider requires an apiKey');
    this.o = {
      baseUrl: 'https://api.openai.com/v1',
      chatModel: 'gpt-4o-mini',
      embeddingModel: 'text-embedding-3-small',
      embeddingDimensions: 1536,
      transcriptionModel: 'whisper-1',
      timeoutMs: 60_000,
      fetchImpl: fetch,
      ...opts,
    };
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.o.timeoutMs);
    let res: Response;
    try {
      res = await this.o.fetchImpl(`${this.o.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new AIProviderError(`AI provider unreachable: ${(e as Error).name}`, true);
    }
    if (!res.ok) {
      // 429 and 5xx are worth retrying; 4xx (bad request, auth) are not.
      throw new AIProviderError(`AI provider returned ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    }
    return (await res.json()) as T;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const r = await this.post<{
      model: string;
      choices: { message: { content: string | null } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    }>(
      '/chat/completions',
      {
        model: this.o.chatModel,
        messages: req.messages,
        max_tokens: req.maxTokens,
        temperature: req.temperature ?? 0.2,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
      },
      req.signal,
    );
    return {
      text: r.choices[0]?.message.content ?? '',
      model: r.model,
      usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: r.usage?.completion_tokens ?? 0 },
    };
  }

  /** Whisper transcription (multipart upload). Audio is sent to the provider only for this call and not logged. */
  async transcribe(audio: Uint8Array, mime: string, filename: string, signal?: AbortSignal): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), filename);
    form.append('model', this.o.transcriptionModel);
    form.append('response_format', 'verbose_json');
    const timeout = AbortSignal.timeout(Math.max(this.o.timeoutMs, 300_000));
    let res: Response;
    try {
      res = await this.o.fetchImpl(`${this.o.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.o.apiKey}` },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (e) {
      throw new AIProviderError(`AI provider unreachable: ${(e as Error).name}`, true);
    }
    if (!res.ok) throw new AIProviderError(`AI provider returned ${res.status}`, res.status === 429 || res.status >= 500, res.status);
    const r = (await res.json()) as { text?: string; duration?: number };
    if (typeof r.text !== 'string') throw new AIProviderError('Transcription response had no text', false);
    return { text: r.text, model: this.o.transcriptionModel, durationSec: r.duration };
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<EmbedResult> {
    const r = await this.post<{ data: { embedding: number[]; index: number }[]; model: string; usage?: { prompt_tokens: number } }>(
      '/embeddings',
      { model: this.o.embeddingModel, input: texts, dimensions: this.o.embeddingDimensions },
      signal,
    );
    const vectors = [...r.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length) throw new AIProviderError('Embedding count mismatch', false);
    return { vectors, model: r.model, version: '1', dimensions: vectors[0]?.length ?? 0, usage: { inputTokens: r.usage?.prompt_tokens ?? 0, outputTokens: 0 } };
  }
}
