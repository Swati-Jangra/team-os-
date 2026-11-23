import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { sql, withContext, type Database, type Tx } from '@teamos/database';
import {
  AIProviderError, MEETING_EXTRACTION_PROMPT, chunkText, meetingExtractionSchema, parseModelJson, type AIProvider,
} from '@teamos/ai-core';
import { parseEventPayload, type EventType } from '@teamos/event-contracts';
import type { JobData } from './queues';

export interface MeetingDeps {
  db: Database;
  ai: AIProvider;
  storageDir: string;
  log: (m: string) => void;
}

export interface MeetingResult {
  action: 'ready' | 'failed' | 'indexed' | 'removed' | 'ignored';
  items?: number;
  reason?: string;
}

interface State {
  organizationId: string;
  workspaceId: string;
  title: string;
  status: string;
  transcript: string | null;
  audioPath: string | null;
  audioMime: string | null;
  deleted: boolean;
}

const MODEL_INPUT_CHARS = 60_000;
const MIME_EXT: Record<string, string> = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/webm': 'webm', 'audio/ogg': 'ogg' };

/**
 * Meeting intelligence. Transcribes audio (if a speech-to-text provider exists), asks the model for a summary plus
 * decisions / action items / blockers, and stores them as PENDING items. NOTHING here creates tasks: a person
 * must approve each action item through the API. Model output is validated with a schema before it is stored,
 * and the transcript is passed as delimited, untrusted data.
 */
export function createMeetingProcessor(deps: MeetingDeps) {
  const loadState = (orgId: string, id: string) =>
    withContext(deps.db, { orgId }, async (trx) => {
      const r = await sql<State>`SELECT organization_id AS "organizationId", workspace_id AS "workspaceId", title, status, transcript,
        audio_path AS "audioPath", audio_mime AS "audioMime", deleted FROM job_meeting_state(${id}::uuid)`.execute(trx);
      return r.rows[0] ?? null;
    });

  const emitProcessed = (trx: Tx, orgId: string, wsId: string, meetingId: string, status: 'READY' | 'FAILED') =>
    trx.insertInto('outboxEvents').values({
      type: 'meeting.processed.v1', version: 1, organizationId: orgId, workspaceId: wsId, lastError: null,
      payload: JSON.stringify({ organizationId: orgId, workspaceId: wsId, meetingId, status }),
    }).execute();

  async function fail(orgId: string, wsId: string, id: string, reason: string): Promise<MeetingResult> {
    await withContext(deps.db, { orgId }, async (trx) => {
      await trx.updateTable('meetings').set({ status: 'FAILED', failureReason: reason.slice(0, 500), updatedAt: new Date() }).where('id', '=', id).execute();
      await emitProcessed(trx, orgId, wsId, id, 'FAILED');
    });
    return { action: 'failed', reason };
  }

  async function removeChunks(orgId: string, id: string): Promise<MeetingResult> {
    await withContext(deps.db, { orgId }, (trx) => trx.deleteFrom('knowledgeChunks').where('sourceType', '=', 'MEETING').where('sourceId', '=', id).execute());
    return { action: 'removed' };
  }

  async function indexTranscript(orgId: string, s: State, id: string, transcript: string): Promise<void> {
    const chunks = chunkText(transcript);
    if (chunks.length === 0) return;
    const e = await deps.ai.embed(chunks.map((c) => `${s.title}\n${c.content}`));
    await withContext(deps.db, { orgId }, async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${'kidx:' + id}))`.execute(trx);
      await trx.deleteFrom('knowledgeChunks').where('sourceType', '=', 'MEETING').where('sourceId', '=', id).execute();
      await trx.insertInto('knowledgeChunks').values(chunks.map((c, i) => ({
        organizationId: orgId, workspaceId: s.workspaceId, sourceType: 'MEETING' as const, sourceId: id, chunkIndex: c.index,
        sourceTitle: s.title, heading: c.heading, content: c.content, embedding: e.vectors[i]!, embeddingModel: e.model,
        embeddingVersion: e.version, sourceVersion: 1,
      }))).execute();
      await trx.insertInto('aiUsage').values({ organizationId: orgId, userId: null, feature: 'embedding', provider: deps.ai.name, model: e.model, inputTokens: e.usage.inputTokens, outputTokens: 0 }).execute();
    });
  }

  async function readAudio(rel: string): Promise<Uint8Array> {
    const root = path.resolve(deps.storageDir);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) throw new Error('Audio path is outside the storage directory');
    return readFile(full);
  }

  async function process(orgId: string, id: string): Promise<MeetingResult> {
    const s = await loadState(orgId, id);
    if (!s || s.organizationId !== orgId || s.deleted) return removeChunks(orgId, id);

    // A retry after we already committed READY (e.g. indexing failed): only the idempotent index step remains.
    if (s.status === 'READY' && s.transcript) {
      await indexTranscript(orgId, s, id, s.transcript);
      return { action: 'indexed' };
    }
    if (s.status !== 'PROCESSING') return { action: 'ignored', reason: `status is ${s.status}` };

    let transcript = s.transcript?.trim() ?? '';
    let source: 'PASTED' | 'AUDIO' = 'PASTED';
    // eslint-disable-next-line prefer-const -- filled by push() in the branches below
    let usage: { feature: string; model: string; inT: number; outT: number }[] = [];

    if (!transcript && s.audioPath) {
      if (!deps.ai.transcribe) return fail(orgId, s.workspaceId, id, 'Audio transcription needs a speech-to-text provider. Set AI_PROVIDER=openai, or paste a transcript instead.');
      let audio: Uint8Array;
      try {
        audio = await readAudio(s.audioPath);
      } catch (e) {
        return fail(orgId, s.workspaceId, id, `Could not read the uploaded audio: ${(e as Error).message}`);
      }
      try {
        const t = await deps.ai.transcribe(audio, s.audioMime ?? 'audio/mpeg', `meeting.${MIME_EXT[s.audioMime ?? ''] ?? 'mp3'}`);
        transcript = t.text.trim();
        source = 'AUDIO';
        usage.push({ feature: 'transcription', model: t.model, inT: Math.round(t.durationSec ?? 0), outT: 0 });
      } catch (e) {
        if (e instanceof AIProviderError && e.retryable) throw e; // BullMQ retries; status stays PROCESSING
        return fail(orgId, s.workspaceId, id, 'The transcription service rejected the audio.');
      }
    }
    if (!transcript) return fail(orgId, s.workspaceId, id, 'There is no transcript or audio to process.');

    let extraction;
    try {
      const r = await deps.ai.chat({
        json: true,
        temperature: 0,
        maxTokens: 2000,
        messages: [
          { role: 'system', content: MEETING_EXTRACTION_PROMPT },
          { role: 'user', content: `Meeting: ${s.title}\n\n<transcript>\n${transcript.slice(0, MODEL_INPUT_CHARS)}\n</transcript>` },
        ],
      });
      usage.push({ feature: 'meeting_extraction', model: r.model, inT: r.usage.inputTokens, outT: r.usage.outputTokens });
      extraction = parseModelJson(meetingExtractionSchema, r.text);
    } catch (e) {
      if (e instanceof AIProviderError && e.retryable) throw e;
      deps.log(`meeting ${id}: unusable model output (${(e as Error).name})`);
      return fail(orgId, s.workspaceId, id, 'The AI returned a response that could not be understood. Try processing again.');
    }

    const rows = [
      ...extraction.decisions.map((d) => ({ kind: 'DECISION' as const, text: d.text, assigneeHint: null, dueDate: null, priority: null })),
      ...extraction.actionItems.map((a) => ({ kind: 'ACTION_ITEM' as const, text: a.text, assigneeHint: a.assigneeName ?? null, dueDate: a.dueDate ?? null, priority: a.priority ?? null })),
      ...extraction.blockers.map((b) => ({ kind: 'BLOCKER' as const, text: b.text, assigneeHint: null, dueDate: null, priority: null })),
    ];

    await withContext(deps.db, { orgId }, async (trx) => {
      // only replace what nobody has decided on yet
      await trx.deleteFrom('meetingItems').where('meetingId', '=', id).where('status', '=', 'PENDING').execute();
      if (rows.length) {
        await trx.insertInto('meetingItems').values(rows.map((r) => ({ ...r, organizationId: orgId, workspaceId: s.workspaceId, meetingId: id }))).execute();
      }
      await trx.updateTable('meetings').set({ status: 'READY', summary: extraction.summary || null, transcript, transcriptSource: source, failureReason: null, updatedAt: new Date() }).where('id', '=', id).execute();
      for (const u of usage) {
        await trx.insertInto('aiUsage').values({ organizationId: orgId, userId: null, feature: u.feature, provider: deps.ai.name, model: u.model, inputTokens: u.inT, outputTokens: u.outT }).execute();
      }
      await emitProcessed(trx, orgId, s.workspaceId, id, 'READY');
    });

    await indexTranscript(orgId, s, id, transcript); // a failure here is retried via the READY branch above
    return { action: 'ready', items: rows.length };
  }

  const handler = async function handle(job: Job<JobData>): Promise<MeetingResult> {
    const type = job.data.type as EventType;
    switch (type) {
      case 'meeting.processing_requested.v1': {
        const p = parseEventPayload(type, job.data.payload) as { organizationId: string; meetingId: string };
        return process(p.organizationId, p.meetingId);
      }
      case 'meeting.deleted.v1': {
        const p = parseEventPayload(type, job.data.payload) as { organizationId: string; meetingId: string };
        return removeChunks(p.organizationId, p.meetingId);
      }
      default:
        return { action: 'ignored' };
    }
  };

  /** Called when BullMQ has exhausted retries, so a meeting never stays "processing" forever. */
  const markExhausted = async (job: Job<JobData>, reason: string): Promise<void> => {
    if ((job.data.type as EventType) !== 'meeting.processing_requested.v1') return;
    const p = job.data.payload as { organizationId: string; workspaceId: string; meetingId: string };
    await fail(p.organizationId, p.workspaceId, p.meetingId, `Processing failed after several attempts: ${reason.slice(0, 200)}`);
  };

  return Object.assign(handler, { markExhausted });
}
