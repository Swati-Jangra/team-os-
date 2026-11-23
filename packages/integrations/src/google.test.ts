import { describe, expect, it } from 'vitest';
import { GoogleClient, GoogleError, assertLabel, normalizeEvent, normalizeMessage } from './index';

const cfg = { clientId: 'cid', clientSecret: 'cs', authUrl: 'https://auth.test/o', tokenUrl: 'https://tok.test/token', revokeUrl: 'https://tok.test/revoke', calendarUrl: 'https://cal.test/v3', gmailUrl: 'https://mail.test/v1' };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const client = (f: (url: string, init?: RequestInit) => Response | Promise<Response>) => new GoogleClient({ ...cfg, fetch: (async (u: string, i?: RequestInit) => f(String(u), i)) as typeof fetch });
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('OAuth', () => {
  it('asks for offline access with the requested (narrow) scope only', () => {
    const u = new URL(client(() => json({})).authorizeUrl('st', 'https://app/cb', ['https://www.googleapis.com/auth/calendar.readonly'], 'a@b.c'));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('include_granted_scopes')).toBe('false');
  });
  it('exchanges a code and refreshes; invalid_grant is non-retryable UNAUTHORIZED', async () => {
    const c = client((url, init) => {
      const b = new URLSearchParams(String(init!.body));
      if (b.get('grant_type') === 'authorization_code') return json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 's' });
      return b.get('refresh_token') === 'rt' ? json({ access_token: 'at2', expires_in: 100 }) : json({ error: 'invalid_grant' }, 400);
    });
    expect(await c.exchangeCode('code', 'https://app/cb', 1000)).toEqual({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1000 + 3_600_000, scope: 's' });
    expect(await c.refresh('rt', 0)).toEqual({ accessToken: 'at2', expiresAt: 100_000 });
    await expect(c.refresh('revoked')).rejects.toMatchObject({ code: 'UNAUTHORIZED', retryable: false });
  });
  it('treats token endpoint outages as retryable', async () => {
    await expect(client(() => json({}, 503)).refresh('x')).rejects.toMatchObject({ code: 'SERVER', retryable: true });
  });
});

describe('calendar', () => {
  it('normalises timed, all-day, tentative and cancelled events; stores no descriptions or attendee emails', () => {
    expect(normalizeEvent({ id: 'a', summary: 'Standup', start: { dateTime: '2026-01-05T09:00:00+05:30' }, end: { dateTime: '2026-01-05T09:30:00+05:30' }, attendees: [{ email: 'x@y.z' }, { email: 'p@q.r' }], description: 'secret' }))
      .toEqual({ externalId: 'a', title: 'Standup', startsAt: '2026-01-05T03:30:00.000Z', endsAt: '2026-01-05T04:00:00.000Z', allDay: false, status: 'confirmed', htmlLink: null, attendeeCount: 2 });
    expect(normalizeEvent({ id: 'b', start: { date: '2026-01-06' }, end: { date: '2026-01-07' }, status: 'tentative' })).toMatchObject({ allDay: true, title: '(no title)', status: 'tentative' });
    expect(normalizeEvent({ id: 'c', status: 'cancelled' })).toEqual({ cancelled: 'c' });
    expect(normalizeEvent({ id: 'd', start: {}, end: {} })).toBeNull();
    expect(normalizeEvent({ start: { date: '2026-01-06' } })).toBeNull();
  });

  it('pages through events, collects cancellations and the sync token; uses no time bounds with a sync token', async () => {
    const urls: string[] = [];
    const c = client((url) => {
      urls.push(url);
      const u = new URL(url);
      if (!u.searchParams.get('pageToken')) return json({ items: [{ id: '1', summary: 'A', start: { dateTime: '2026-01-05T09:00:00Z' }, end: { dateTime: '2026-01-05T10:00:00Z' } }], nextPageToken: 'p2' });
      return json({ items: [{ id: '2', status: 'cancelled' }], nextSyncToken: 'tok-9' });
    });
    const r = await c.listEvents('t', 'team@x.com', { timeMin: '2026-01-01T00:00:00Z', timeMax: '2026-03-01T00:00:00Z' });
    expect(r).toMatchObject({ cancelledIds: ['2'], nextSyncToken: 'tok-9' });
    expect(r.events.map((e) => e.externalId)).toEqual(['1']);
    expect(urls[0]).toContain('/calendars/team%40x.com/events');
    expect(urls[0]).toContain('timeMin=');
    await client((u) => { urls.push(u); return json({ items: [], nextSyncToken: 'n' }); }).listEvents('t', 'c', { syncToken: 'old', timeMin: 'ignored' });
    expect(urls.at(-1)).toContain('syncToken=old');
    expect(urls.at(-1)).not.toContain('timeMin');
  });

  it('never returns a sync token when it gave up paging (so nothing is skipped next time)', async () => {
    const r = await client(() => json({ items: [], nextPageToken: 'more' })).listEvents('t', 'c', { maxPages: 2 });
    expect(r.nextSyncToken).toBeNull();
  });

  it('maps 410 to GONE, 401 to UNAUTHORIZED, rate limits to retryable', async () => {
    await expect(client(() => json({}, 410)).listEvents('t', 'c', { syncToken: 'x' })).rejects.toMatchObject({ code: 'GONE', retryable: false });
    await expect(client(() => json({}, 401)).listCalendars('t')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(client(() => new Response('{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', { status: 403 })).listCalendars('t')).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    await expect(client(() => json({}, 403)).listCalendars('t')).rejects.toMatchObject({ code: 'FORBIDDEN', retryable: false });
  });

  it('lists calendars', async () => {
    const r = await client(() => json({ items: [{ id: 'primary@x.com', summary: 'Me', primary: true }, { id: 'team', summary: 'Team', summaryOverride: 'My Team' }] })).listCalendars('t');
    expect(r).toEqual([{ id: 'primary@x.com', name: 'Me', primary: true }, { id: 'team', name: 'My Team', primary: false }]);
  });
});

describe('mail', () => {
  const msg = (text: string, extra: object = {}) => ({
    id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-01-05T10:00:00Z')),
    payload: { headers: [{ name: 'Subject', value: 'APO-3 plan' }, { name: 'From', value: 'Ann <ann@x.com>' }], mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64(text) } }, { mimeType: 'text/html', body: { data: b64('<b>html</b>') } }] }, ...extra,
  });
  it('extracts the new text only: no quoted replies, no signature, bounded', () => {
    const m = normalizeMessage(msg('We decided to ship Friday.\n\n> old quoted line\nOn Mon, Jan 4, 2026 at 9:00 AM Bob <b@x.com> wrote:\n> more\n'))!;
    expect(m).toMatchObject({ externalId: 'm1', threadId: 't1', subject: 'APO-3 plan', from: 'ann@x.com', receivedAt: '2026-01-05T10:00:00.000Z' });
    expect(m.excerpt).toBe('We decided to ship Friday.');
    expect(normalizeMessage(msg('x'.repeat(10_000)))!.excerpt).toHaveLength(4000);
    expect(normalizeMessage(msg('Thanks\n-- \nAnn\nCEO'))!.excerpt).toBe('Thanks');
  });
  it('falls back to HTML with tags stripped and ignores bad ids', () => {
    const m = normalizeMessage({ id: 'h', internalDate: '1', payload: { headers: [], mimeType: 'text/html', body: { data: b64('<style>p{}</style><p>Hello <b>there</b></p>') } } })!;
    expect(m.excerpt).toBe('Hello there');
    expect(m.subject).toBe('(no subject)');
    expect(normalizeMessage({ payload: {} })).toBeNull();
  });
  it('queries only the configured label, after a cursor, and rejects injection in label or id', async () => {
    let seen = '';
    const c = client((u) => { seen = u; return json({ messages: [{ id: 'a' }, { id: 'b' }] }); });
    expect(await c.listMessageIds('t', 'TeamOS', 1700000000.7)).toEqual(['a', 'b']);
    expect(new URL(seen).searchParams.get('q')).toBe('label:"TeamOS" after:1700000000');
    expect(() => assertLabel('x" OR in:anywhere')).toThrow(GoogleError);
    await expect(c.listMessageIds('t', 'a" in:inbox')).rejects.toBeInstanceOf(GoogleError);
    await expect(c.getMessage('t', '../../x')).rejects.toBeInstanceOf(GoogleError);
  });
});
