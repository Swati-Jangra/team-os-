export type GoogleErrorCode = 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND' | 'GONE' | 'RATE_LIMITED' | 'SERVER' | 'NETWORK' | 'BAD_RESPONSE';
export class GoogleError extends Error {
  constructor(message: string, readonly code: GoogleErrorCode, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = 'GoogleError';
  }
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string; // https://accounts.google.com/o/oauth2/v2/auth
  tokenUrl: string; // https://oauth2.googleapis.com/token
  revokeUrl: string; // https://oauth2.googleapis.com/revoke
  calendarUrl: string; // https://www.googleapis.com/calendar/v3
  gmailUrl: string; // https://gmail.googleapis.com/gmail/v1
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Narrowest read-only scopes that do the job. Gmail's readonly scope is "restricted": see docs for Google's verification. */
export const GOOGLE_SCOPES = {
  calendar: ['https://www.googleapis.com/auth/calendar.readonly'],
  mail: ['https://www.googleapis.com/auth/gmail.readonly'],
} as const;

export interface GoogleTokens { accessToken: string; refreshToken: string | null; expiresAt: number; scope: string }
export interface CalendarInfo { id: string; name: string; primary: boolean }
export interface CalendarEvent {
  externalId: string;
  title: string;
  startsAt: string; // ISO
  endsAt: string;
  allDay: boolean;
  status: 'confirmed' | 'tentative';
  htmlLink: string | null;
  attendeeCount: number;
}
export interface EventsPage { events: CalendarEvent[]; cancelledIds: string[]; nextSyncToken: string | null }
export interface MailMessage { externalId: string; threadId: string | null; subject: string; from: string | null; receivedAt: string; excerpt: string }

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export const EXCERPT_CHARS = 4000;

export function normalizeEvent(e: Json): CalendarEvent | { cancelled: string } | null {
  const id = typeof e.id === 'string' ? e.id : null;
  if (!id) return null;
  if (e.status === 'cancelled') return { cancelled: id };
  const allDay = !e.start?.dateTime && !!e.start?.date;
  const s = e.start?.dateTime ?? (e.start?.date ? `${e.start.date}T00:00:00Z` : null);
  const en = e.end?.dateTime ?? (e.end?.date ? `${e.end.date}T00:00:00Z` : null);
  if (!s || !en || Number.isNaN(Date.parse(s)) || Number.isNaN(Date.parse(en))) return null;
  return {
    externalId: id, title: String(e.summary ?? '(no title)').slice(0, 300), startsAt: new Date(s).toISOString(), endsAt: new Date(en).toISOString(), allDay,
    status: e.status === 'tentative' ? 'tentative' : 'confirmed', htmlLink: typeof e.htmlLink === 'string' ? e.htmlLink : null,
    attendeeCount: Array.isArray(e.attendees) ? e.attendees.length : 0,
  };
}

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const stripHtml = (h: string) => h.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
function findPart(p: Json | undefined, mime: string): string | null {
  if (!p) return null;
  if (p.mimeType === mime && typeof p.body?.data === 'string') return b64(p.body.data);
  for (const c of p.parts ?? []) {
    const r = findPart(c, mime);
    if (r) return r;
  }
  return null;
}
/** Keep only the new text of a message: plain part (or tags stripped from HTML), quoted replies and signatures-after-"-- " dropped, bounded. */
export function normalizeMessage(m: Json): MailMessage | null {
  if (typeof m.id !== 'string') return null;
  const hdr = (n: string) => (m.payload?.headers ?? []).find((h: Json) => String(h.name).toLowerCase() === n)?.value as string | undefined;
  let text = findPart(m.payload, 'text/plain') ?? (findPart(m.payload, 'text/html') ? stripHtml(findPart(m.payload, 'text/html')!) : '');
  text = text.replace(/\r/g, '').split('\n').filter((l) => !l.startsWith('>')).join('\n');
  const cut = text.search(/^On .{5,120} wrote:\s*$/m);
  if (cut > 0) text = text.slice(0, cut);
  text = text.replace(/\n-- \n[\s\S]*$/, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, EXCERPT_CHARS);
  const ms = Number(m.internalDate);
  const from = hdr('from');
  const addr = from ? (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().slice(0, 200) : null;
  return {
    externalId: m.id, threadId: typeof m.threadId === 'string' ? m.threadId : null, subject: (hdr('subject') ?? '(no subject)').slice(0, 300), from: addr,
    receivedAt: new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now()).toISOString(), excerpt: text,
  };
}

/** The label goes into a Gmail search query: allow only plain label characters. */
export function assertLabel(label: string): void {
  if (!/^[A-Za-z0-9 _\-/]{1,100}$/.test(label)) throw new GoogleError('Invalid label name', 'BAD_RESPONSE', null, false);
}

export class GoogleClient {
  private readonly f: typeof fetch;
  constructor(private readonly cfg: GoogleConfig) {
    this.f = cfg.fetch ?? fetch;
  }

  authorizeUrl(state: string, redirectUri: string, scopes: readonly string[], loginHint?: string): string {
    const q = new URLSearchParams({ client_id: this.cfg.clientId, redirect_uri: redirectUri, response_type: 'code', scope: scopes.join(' '), state, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false' });
    if (loginHint) q.set('login_hint', loginHint);
    return `${this.cfg.authUrl}?${q}`;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.f(url, { ...init, signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000) });
    } catch (e) {
      throw new GoogleError(`Google is unreachable: ${e instanceof Error ? e.message : 'network error'}`, 'NETWORK', null, true);
    }
    if (res.ok) return res;
    if (res.status === 429) throw new GoogleError('Google rate limit reached', 'RATE_LIMITED', 429, true);
    if (res.status === 401) throw new GoogleError('Google rejected the access token', 'UNAUTHORIZED', 401, false);
    if (res.status === 403) {
      const body = await res.text().catch(() => '');
      if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/.test(body)) throw new GoogleError('Google rate limit reached', 'RATE_LIMITED', 403, true);
      throw new GoogleError('Google denied access to this resource', 'FORBIDDEN', 403, false);
    }
    if (res.status === 404) throw new GoogleError('Not found on Google (or no access)', 'NOT_FOUND', 404, false);
    if (res.status === 410) throw new GoogleError('Google sync state expired', 'GONE', 410, false);
    if (res.status >= 500) throw new GoogleError(`Google error ${res.status}`, 'SERVER', res.status, true);
    throw new GoogleError(`Google request failed (${res.status})`, 'BAD_RESPONSE', res.status, false);
  }

  private async get<T>(token: string, url: string): Promise<T> {
    const res = await this.send(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    try {
      return (await res.json()) as T;
    } catch {
      throw new GoogleError('Google returned an unreadable response', 'BAD_RESPONSE', res.status, false);
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<Json> {
    let res: Response;
    try {
      res = await this.f(this.cfg.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, ...params }), signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000) });
    } catch (e) {
      throw new GoogleError(`Google is unreachable: ${e instanceof Error ? e.message : 'network error'}`, 'NETWORK', null, true);
    }
    const j = (await res.json().catch(() => ({}))) as Json;
    if (res.status >= 500 || res.status === 429) throw new GoogleError('Google token endpoint unavailable', 'SERVER', res.status, true);
    if (!res.ok || typeof j.access_token !== 'string') {
      // invalid_grant = the refresh token was revoked or expired: a person must reconnect, retrying cannot help
      throw new GoogleError(`Google did not issue a token${j.error ? ` (${String(j.error)})` : ''}`, j.error === 'invalid_grant' ? 'UNAUTHORIZED' : 'BAD_RESPONSE', res.status, false);
    }
    return j;
  }

  async exchangeCode(code: string, redirectUri: string, now = Date.now()): Promise<GoogleTokens> {
    const j = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    return { accessToken: j.access_token, refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null, expiresAt: now + Number(j.expires_in ?? 3600) * 1000, scope: String(j.scope ?? '') };
  }
  async refresh(refreshToken: string, now = Date.now()): Promise<{ accessToken: string; expiresAt: number }> {
    const j = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    return { accessToken: j.access_token, expiresAt: now + Number(j.expires_in ?? 3600) * 1000 };
  }
  /** Best effort: tells Google to invalidate the grant when a person disconnects. */
  async revoke(token: string): Promise<void> {
    await this.send(this.cfg.revokeUrl, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) });
  }

  // ---- calendar
  async listCalendars(token: string): Promise<CalendarInfo[]> {
    const r = await this.get<Json>(token, `${this.cfg.calendarUrl}/users/me/calendarList?minAccessRole=reader&maxResults=100`);
    return (r.items ?? []).map((c: Json) => ({ id: String(c.id), name: String(c.summaryOverride ?? c.summary ?? c.id).slice(0, 200), primary: Boolean(c.primary) }));
  }

  /**
   * Incremental when `syncToken` is given (Google then forbids time bounds); otherwise a bounded full sync. Cancelled events are reported
   * separately so the caller can delete them. A 410 means the token expired: the caller must drop it and run a full sync.
   */
  async listEvents(token: string, calendarId: string, opts: { syncToken?: string | null; timeMin?: string; timeMax?: string; maxPages?: number }): Promise<EventsPage> {
    const events: CalendarEvent[] = [];
    const cancelledIds: string[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    for (let i = 0; i < (opts.maxPages ?? 10); i++) {
      const q = new URLSearchParams({ singleEvents: 'true', showDeleted: 'true', maxResults: '250' });
      if (opts.syncToken) q.set('syncToken', opts.syncToken);
      else { if (opts.timeMin) q.set('timeMin', opts.timeMin); if (opts.timeMax) q.set('timeMax', opts.timeMax); }
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.get<Json>(token, `${this.cfg.calendarUrl}/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      for (const raw of r.items ?? []) {
        const n = normalizeEvent(raw);
        if (!n) continue;
        if ('cancelled' in n) cancelledIds.push(n.cancelled); else events.push(n);
      }
      if (typeof r.nextPageToken === 'string') { pageToken = r.nextPageToken; continue; }
      nextSyncToken = typeof r.nextSyncToken === 'string' ? r.nextSyncToken : null;
      return { events, cancelledIds, nextSyncToken };
    }
    // too many pages: report what we have WITHOUT a sync token so the next run starts over rather than skipping events
    return { events, cancelledIds, nextSyncToken: null };
  }

  // ---- mail
  async getMailAddress(token: string): Promise<string> {
    const p = await this.get<Json>(token, `${this.cfg.gmailUrl}/users/me/profile`);
    return String(p.emailAddress);
  }
  async listMessageIds(token: string, label: string, afterEpochSec: number | null, max = 50): Promise<string[]> {
    assertLabel(label);
    const qs = new URLSearchParams({ q: `label:"${label}"${afterEpochSec ? ` after:${Math.floor(afterEpochSec)}` : ''}`, maxResults: String(Math.min(max, 100)) });
    const r = await this.get<Json>(token, `${this.cfg.gmailUrl}/users/me/messages?${qs}`);
    return (r.messages ?? []).map((m: Json) => String(m.id));
  }
  async getMessage(token: string, id: string): Promise<MailMessage | null> {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new GoogleError('Invalid message id', 'BAD_RESPONSE', null, false);
    return normalizeMessage(await this.get<Json>(token, `${this.cfg.gmailUrl}/users/me/messages/${id}?format=full`));
  }
}
