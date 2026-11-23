import { describe, expect, it, vi } from 'vitest';
import { AIProviderError, LocalProvider, OpenAIProvider, chunkText, createProvider, hashEmbed, htmlToText } from './index';

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe('hashEmbed', () => {
  it('is deterministic, unit length, and ranks lexical overlap higher', () => {
    const q = hashEmbed('database migration rollback plan');
    expect(hashEmbed('database migration rollback plan')).toEqual(q);
    expect(Math.hypot(...q)).toBeCloseTo(1, 5);
    expect(dot(q, hashEmbed('rollback plan for the database migration'))).toBeGreaterThan(dot(q, hashEmbed('office snack budget for friday')));
  });
});

describe('chunkText', () => {
  it('keeps headings, respects size and overlaps', () => {
    const para = (n: number) => `Sentence ${n} about deployments. `.repeat(20);
    const text = `# Intro\n\n${para(1)}\n\n## Rollout\n\n${para(2)}\n\n${para(3)}`;
    const chunks = chunkText(text, { maxChars: 500, overlapChars: 60 });
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.content.length <= 700)).toBe(true);
    expect(chunks[0]!.heading).toBe('Intro');
    expect(chunks.at(-1)!.heading).toBe('Rollout');
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });
  it('indexes heading-only documents instead of dropping them', () => {
    const c = chunkText('## Launch plan\n\n## Canary release Monday');
    expect(c).toHaveLength(1);
    expect(c[0]!.content).toContain('Canary release Monday');
    expect(c[0]!.heading).toBe('Canary release Monday');
  });
  it('returns nothing for empty input and one chunk for short input', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
    expect(chunkText('hello world')).toHaveLength(1);
  });
});

describe('htmlToText', () => {
  it('turns headings into markdown lines and drops tags/scripts', () => {
    const t = htmlToText('<h2>Plan</h2><p>Ship &amp; learn</p><script>alert(1)</script><ul><li>one</li></ul>');
    expect(t).toContain('## Plan');
    expect(t).toContain('Ship & learn');
    expect(t).not.toContain('alert');
    expect(t).not.toContain('<');
  });
});

describe('LocalProvider', () => {
  it('embeds in batch and answers from numbered context with citations', async () => {
    const p = new LocalProvider();
    const e = await p.embed(['a b', 'c d']);
    expect(e.vectors).toHaveLength(2);
    expect(e.dimensions).toBe(256);
    const r = await p.chat({ messages: [{ role: 'user', content: 'Q?\n[1] Doc A\nThe rollout starts Monday.\n' }] });
    expect(r.text).toContain('[1]');
    expect((await p.chat({ messages: [{ role: 'user', content: 'Q?' }] })).text).toMatch(/could not find/);
  });
});

describe('OpenAIProvider', () => {
  const mk = (fetchImpl: typeof fetch) => new OpenAIProvider({ apiKey: 'sk-test', fetchImpl });
  it('classifies errors for retry and never leaks the key', async () => {
    const f429 = mk(vi.fn(async () => new Response('{}', { status: 429 })) as never);
    await expect(f429.chat({ messages: [] })).rejects.toMatchObject({ retryable: true, status: 429 });
    const f401 = mk(vi.fn(async () => new Response('{}', { status: 401 })) as never);
    const err = await f401.chat({ messages: [] }).catch((e) => e as AIProviderError);
    expect(err).toMatchObject({ retryable: false, status: 401 });
    expect(String(err.message)).not.toContain('sk-test');
    const net = mk(vi.fn(async () => { throw new TypeError('boom'); }) as never);
    await expect(net.embed(['x'])).rejects.toMatchObject({ retryable: true });
  });
  it('parses embeddings in index order', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ model: 'm', data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] }), { status: 200 }));
    const r = await mk(f as never).embed(['a', 'b']);
    expect(r.vectors).toEqual([[1, 0], [0, 1]]);
  });
});

describe('createProvider', () => {
  it('defaults to local and requires a key for openai', () => {
    expect(createProvider({}).name).toBe('local');
    expect(() => createProvider({ AI_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(createProvider({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k' }).name).toBe('openai');
  });
});

import { MEETING_EXTRACTION_PROMPT, PLAN_TASK_MARKER, PROJECT_PLAN_PROMPT, meetingExtractionSchema, parseModelJson, projectPlanSchema } from './index';

describe('structured outputs', () => {
  it('parses fenced/prose-wrapped JSON and rejects junk or oversize output', () => {
    const raw = 'Sure!\n```json\n{"summary":"s","actionItems":[{"text":"Ship it","dueDate":"2026-12-01"}]}\n```';
    const r = parseModelJson(meetingExtractionSchema, raw);
    expect(r.actionItems[0]).toMatchObject({ text: 'Ship it', dueDate: '2026-12-01' });
    expect(r.decisions).toEqual([]);
    expect(() => parseModelJson(meetingExtractionSchema, 'no json here')).toThrow();
    expect(() => parseModelJson(meetingExtractionSchema, '{"actionItems":[{"text":"x","dueDate":"tomorrow"}]}')).toThrow();
    expect(() => parseModelJson(projectPlanSchema, '{"tasks":[]}')).toThrow();
  });
  it('local provider extracts marked items and plans bullet lists offline', async () => {
    const p = new LocalProvider();
    const t = await p.chat({ json: true, messages: [{ role: 'system', content: MEETING_EXTRACTION_PROMPT }, { role: 'user', content: '<transcript>\nAnna: We reviewed the roadmap.\nDecision: Ship on Friday\nBob: Action: Dana to update the docs by 2026-12-01\nBlocker: staging is down\n</transcript>' }] });
    const e = parseModelJson(meetingExtractionSchema, t.text);
    expect(e.decisions[0]!.text).toBe('Ship on Friday');
    expect(e.actionItems[0]).toMatchObject({ assigneeName: 'Dana', dueDate: '2026-12-01' });
    expect(e.blockers[0]!.text).toBe('staging is down');
    const pl = await p.chat({ json: true, messages: [{ role: 'system', content: PROJECT_PLAN_PROMPT }, { role: 'user', content: '<goal>\n- Design schema\n- Build API\n- Write tests\n</goal>' }] });
    const plan = parseModelJson(projectPlanSchema, pl.text);
    expect(plan.tasks.map((x) => x.title)).toEqual(['Design schema', 'Build API', 'Write tests']);
    expect(plan.tasks[2]!.dependsOn).toEqual([1]);
    expect(PLAN_TASK_MARKER).toContain('PLAN');
  });
  it('OpenAI transcription posts multipart and surfaces retryable errors', async () => {
    const ok = vi.fn(async (_u: unknown, init?: { body?: unknown }) => {
      expect(init!.body).toBeInstanceOf(FormData);
      return new Response(JSON.stringify({ text: 'hello', duration: 3.2 }), { status: 200 });
    });
    const r = await new OpenAIProvider({ apiKey: 'k', fetchImpl: ok as never }).transcribe!(new Uint8Array([1, 2]), 'audio/mpeg', 'a.mp3');
    expect(r).toMatchObject({ text: 'hello', durationSec: 3.2 });
    await expect(new OpenAIProvider({ apiKey: 'k', fetchImpl: (async () => new Response('{}', { status: 503 })) as never }).transcribe!(new Uint8Array(1), 'audio/mpeg', 'a.mp3')).rejects.toMatchObject({ retryable: true });
    expect(new LocalProvider().transcribe).toBeUndefined();
  });
});
