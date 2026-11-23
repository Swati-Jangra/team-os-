// Minimal Google stand-in: OAuth consent redirect, token/refresh/revoke, Calendar list+events (syncToken), Gmail profile/list/get.
const http = require('http');
const st = { ver: 1, events: [], messages: [], revoked: [], calls: [], refreshes: 0 };
const json = (res, code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
const b64 = (s) => Buffer.from(s).toString('base64url');
http.createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; st.calls.push(`${req.method} ${p}`);
    if (p === '/auth') { const r = new URL(u.searchParams.get('redirect_uri')); r.searchParams.set('code', u.searchParams.get('scope').includes('gmail') ? 'mail' : 'cal'); r.searchParams.set('state', u.searchParams.get('state')); res.writeHead(302, { location: r.href }); return res.end(); }
    if (p === '/token') {
      const b = new URLSearchParams(data);
      if (b.get('grant_type') === 'refresh_token') { st.refreshes++; return json(res, 200, { access_token: 'at-refreshed', expires_in: 3600 }); }
      return b.get('code') === 'mail'
        ? json(res, 200, { access_token: 'at-mail', refresh_token: 'rt-mail', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' })
        : json(res, 200, { access_token: 'at-cal', refresh_token: 'rt-cal', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar.readonly' });
    }
    if (p === '/revoke') { st.revoked.push(new URLSearchParams(data).get('token')); return json(res, 200, {}); }
    if (p === '/__state') return json(res, 200, st);
    if (p === '/__event' && req.method === 'POST') { const e = JSON.parse(data); const i = st.events.findIndex((x) => x.id === e.id); st.ver++; e.ver = st.ver; if (i >= 0) st.events[i] = e; else st.events.push(e); return json(res, 200, { ok: true }); }
    if (p === '/__message' && req.method === 'POST') { st.messages.push(JSON.parse(data)); return json(res, 200, { ok: true }); }
    if (p === '/calendar/v3/users/me/calendarList') return json(res, 200, { items: [{ id: 'me@example.com', summary: 'Me', primary: true }, { id: 'team@example.com', summary: 'Team calendar' }] });
    if (/^\/calendar\/v3\/calendars\/[^/]+\/events$/.test(p)) {
      const tok = u.searchParams.get('syncToken'); const since = tok ? Number(tok.slice(1)) : 0;
      const items = st.events.filter((e) => e.ver > since).map(({ ver, ...e }) => e);
      return json(res, 200, { items, nextSyncToken: `v${st.ver}` });
    }
    if (p === '/gmail/v1/users/me/profile') return json(res, 200, { emailAddress: 'box@example.com' });
    if (p === '/gmail/v1/users/me/messages') return json(res, 200, { messages: st.messages.map((m) => ({ id: m.id })) });
    let m; if ((m = /^\/gmail\/v1\/users\/me\/messages\/([\w-]+)$/.exec(p))) {
      const msg = st.messages.find((x) => x.id === m[1]); if (!msg) return json(res, 404, {});
      return json(res, 200, { id: msg.id, threadId: 't-' + msg.id, internalDate: String(Date.now() - 3600_000), payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: msg.subject }, { name: 'From', value: 'Ann <ann@example.com>' }], body: { data: b64(msg.body) } } });
    }
    json(res, 404, {});
  });
}).listen(4520, () => console.log('mock google on 4520'));
