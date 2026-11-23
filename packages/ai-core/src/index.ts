export * from './types';
export * from './chunker';
export * from './local';
export * from './openai';
export * from './tasks';

import { LocalProvider } from './local';
import { OpenAIProvider } from './openai';
import type { AIProvider } from './types';

/** Picks the provider from config: a real one only when a key is present; otherwise the offline local provider. */
export function createProvider(env: { AI_PROVIDER?: string; OPENAI_API_KEY?: string; OPENAI_BASE_URL?: string; OPENAI_CHAT_MODEL?: string; OPENAI_EMBEDDING_MODEL?: string }): AIProvider {
  if (env.AI_PROVIDER === 'openai') {
    if (!env.OPENAI_API_KEY) throw new Error('AI_PROVIDER=openai requires OPENAI_API_KEY');
    return new OpenAIProvider({ apiKey: env.OPENAI_API_KEY, baseUrl: env.OPENAI_BASE_URL, chatModel: env.OPENAI_CHAT_MODEL, embeddingModel: env.OPENAI_EMBEDDING_MODEL });
  }
  return new LocalProvider();
}
