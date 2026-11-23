// Closed-loop load test of the main endpoints.
// Usage: node scripts/perf/load.js '<seed.js output JSON>' [concurrency=10] [requests per case=200]
const B = process.env.BASE ?? 'http://localhost:4400/api/v1';
const seed = JSON.parse(process.argv[2]); const C = Number(process.argv[3] ?? 10), N = Number(process.argv[4] ?? 200);
let cookie = '', csrf = '';
async function raw(m, p, body, ck = cookie) {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie: ck, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? [];
  const txt = await r.text(); return { status: r.status, sc, size: txt.length };
}
(async () => {
  const r = await raw('POST', '/auth/login', { email: seed.email, password: seed.password });
  cookie = r.sc.map((c) => c.split(';')[0]).join('; '); csrf = decodeURIComponent((cookie.match(/teamos_csrf=([^;]+)/) ?? [])[1] ?? '');
  const O = `/organizations/${seed.O}`;
  let n = 0;
  const cases = [
    ['GET auth/me', 'GET', '/auth/me'],
    ['GET health/ready', 'GET', '/health/ready'],
    ['GET projects', 'GET', `${O}/projects`],
    ['GET project tasks (300k, capped)', 'GET', `${O}/projects/${seed.P}/tasks`],
    ['GET project tasks ?status=DONE', 'GET', `${O}/projects/${seed.P}/tasks?status=DONE`],
    ['GET project tasks ?q=md5', 'GET', `${O}/projects/${seed.P}/tasks?q=Task%20number%2012345`],
    ['GET tasks/mine', 'GET', `${O}/tasks/mine`],
    ['GET notifications', 'GET', `${O}/notifications`],
    ['GET notifications/unread-count', 'GET', `${O}/notifications/unread-count`],
    ['GET audit-logs p1', 'GET', `${O}/audit-logs`],
    ['GET audit-logs p500', 'GET', `${O}/audit-logs?page=500&pageSize=100`],
    ['GET project activity', 'GET', `${O}/projects/${seed.P}/activity`],
    ['POST knowledge/search (20k chunks)', 'POST', `${O}/knowledge/search`, { query: 'release planning risk budget' }],
    ['POST create task', 'POST', `${O}/projects/${seed.P}/tasks`, () => ({ title: 'Load test ' + n++ })],
  ];
  const out = [];
  for (const [name, m, p, b] of cases) {
    const lat = []; let errors = 0; let next = 0; const statuses = {}; let size = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: C }, async () => {
      while (next++ < N) {
        const s = performance.now();
        const res = await raw(m, p, typeof b === 'function' ? b() : b);
        lat.push(performance.now() - s); statuses[res.status] = (statuses[res.status] ?? 0) + 1; size = res.size;
        if (res.status >= 400) errors++;
      }
    }));
    const wall = (performance.now() - t0) / 1000; lat.sort((a, b) => a - b);
    const q = (x) => lat[Math.min(lat.length - 1, Math.floor(lat.length * x))].toFixed(0);
    out.push({ name, rps: (lat.length / wall).toFixed(0), p50: q(0.5), p95: q(0.95), p99: q(0.99), kb: (size / 1024).toFixed(0), status: JSON.stringify(statuses) });
  }
  console.log(`concurrency=${C} requests/case=${N}`);
  console.table(out);
})();
