// Minimal GitHub stand-in: OAuth + REST + hooks. State is inspectable at /__state, PRs can be added via POST /__pr.
const http = require('http');
const st = { hooks: {}, nextHook: 500, prs: [], deletedHooks: [], valid: true, calls: 0 };
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
http.createServer((req, res) => {
  let data = ''; req.on('data', (c) => (data += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'); const p = u.pathname; st.calls++;
    if (p === '/login/oauth/authorize') { const r = new URL(u.searchParams.get('redirect_uri')); r.searchParams.set('code', 'mock-code'); r.searchParams.set('state', u.searchParams.get('state')); res.writeHead(302, { location: r.href }); return res.end(); }
    if (p === '/login/oauth/access_token') return send(res, 200, { access_token: 'gho_mock_token', scope: 'repo,admin:repo_hook' });
    if (p === '/__state') return send(res, 200, st);
    if (p === '/__valid') { st.valid = u.searchParams.get('v') === '1'; return send(res, 200, { ok: true }); }
    if (p === '/__pr' && req.method === 'POST') { st.prs.push(JSON.parse(data)); return send(res, 200, { ok: true }); }
    if (!st.valid) return send(res, 401, { message: 'Bad credentials' });
    if (p === '/user') return send(res, 200, { id: 7, login: 'mock-octo' });
    if (p === '/user/repos') return send(res, 200, [{ id: 11, full_name: 'acme/api', private: true }, { id: 12, full_name: 'acme/web', private: false }]);
    let m;
    if ((m = /^\/repos\/(acme\/[\w.-]+)$/.exec(p))) return send(res, 200, { id: 11, full_name: m[1], private: true });
    if ((m = /^\/repos\/(acme\/[\w.-]+)\/hooks$/.exec(p)) && req.method === 'POST') { const b = JSON.parse(data); const id = st.nextHook++; st.hooks[id] = { repo: m[1], url: b.config.url, secret: b.config.secret }; return send(res, 201, { id }); }
    if ((m = /^\/repos\/(acme\/[\w.-]+)\/hooks\/(\d+)$/.exec(p)) && req.method === 'DELETE') { delete st.hooks[m[2]]; st.deletedHooks.push(Number(m[2])); return send(res, 204); }
    if (/\/pulls$/.test(p)) return send(res, 200, st.prs);
    return send(res, 200, []);
  });
}).listen(4510, () => console.log('mock github on 4510'));
