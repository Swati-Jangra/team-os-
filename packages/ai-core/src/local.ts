import { MEETING_TASK_MARKER, PLAN_TASK_MARKER } from './tasks';
import type { AIProvider, ChatRequest, ChatResult, EmbedResult } from './types';

const DIMS = 256;

function fnv(str: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export const tokenize = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Deterministic hashed bag-of-words embedding (feature hashing + L2 normalisation).
 * It captures lexical overlap only — NOT real semantics. It exists so development, tests and demos
 * run offline and reproducibly. Production must use a real embedding model.
 */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const tok of tokenize(text)) {
    const idx = fnv(tok, 1) % DIMS;
    v[idx]! += fnv(tok, 2) % 2 === 0 ? 1 : -1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

/**
 * Offline provider for dev/tests. `chat` is a scripted stand-in: it answers from the CONTEXT block it is given
 * (first lines of each numbered source) so the RAG plumbing, citations and permissions can be verified
 * without a model. It is not an intelligent assistant and the UI labels it as such.
 */
export class LocalProvider implements AIProvider {
  readonly name = 'local';
  /** Optional hook so tests can script chat output (e.g. JSON for extraction). */
  constructor(private readonly script?: (req: ChatRequest) => string | undefined) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    return {
      vectors: texts.map(hashEmbed),
      model: 'local-hash-256',
      version: '1',
      dimensions: DIMS,
      usage: { inputTokens: texts.reduce((s, t) => s + tokenize(t).length, 0), outputTokens: 0 },
    };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const scripted = this.script?.(req) ?? offlineStructured(req);
    const last = req.messages.filter((m) => m.role === 'user').pop()?.content ?? '';
    let text = scripted;
    if (text === undefined) {
      const sources = [...last.matchAll(/\[(\d+)\]\s+([^\n]+)\n([^\n]*)/g)];
      text = sources.length
        ? 'Based on the retrieved sources: ' + sources.slice(0, 3).map((m) => `${m[3]!.slice(0, 160)} [${m[1]}]`).join(' ')
        : 'I could not find anything relevant in the knowledge base.';
    }
    return {
      text,
      model: 'local-scripted',
      usage: { inputTokens: req.messages.reduce((s, m) => s + tokenize(m.content).length, 0), outputTokens: tokenize(text).length },
    };
  }
}


/**
 * Offline rule-based stand-in for the two structured tasks, so the full flow works without a model.
 * It only understands explicit markers ("Decision: …", "Action: …", "Blocker: …", bullet lists) — it does NOT
 * understand natural language. Real extraction and planning need a real model (AI_PROVIDER=openai).
 */
function offlineStructured(req: ChatRequest): string | undefined {
  const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
  const user = req.messages.filter((m) => m.role === 'user').pop()?.content ?? '';
  const between = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(user)?.[1] ?? '';
  if (sys.includes(MEETING_TASK_MARKER)) {
    const lines = between('transcript').split('\n').map((l) => l.trim()).filter(Boolean);
    const pick = (label: string) =>
      lines.flatMap((l) => {
        const m = new RegExp(`^(?:[^:]{1,40}:\\s*)?${label}s?:\\s*(.+)$`, 'i').exec(l);
        return m ? [m[1]!.trim()] : [];
      });
    const actions = pick('action').map((t) => {
      const owner = /^@?([A-Z][a-z]+)\s+(?:to|will)\s+/.exec(t)?.[1] ?? null;
      const due = /\bby (\d{4}-\d{2}-\d{2})\b/.exec(t)?.[1] ?? null;
      return { text: t, assigneeName: owner, dueDate: due };
    });
    return JSON.stringify({
      summary: lines.filter((l) => !/^(?:[^:]{1,40}:\s*)?(?:decision|action|blocker)s?:/i.test(l)).slice(0, 3).join(' '),
      decisions: pick('decision').map((text) => ({ text })),
      actionItems: actions,
      blockers: pick('blocker').map((text) => ({ text })),
    });
  }
  if (sys.includes(PLAN_TASK_MARKER)) {
    const goal = between('goal');
    const bullets = goal.split('\n').map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim()).filter((x): x is string => !!x);
    const titles = bullets.length ? bullets : goal.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 3);
    return JSON.stringify({ tasks: titles.slice(0, 25).map((title, i) => ({ title: title.slice(0, 300), dependsOn: i > 0 ? [i - 1] : [] })) });
  }
  return undefined;
}
