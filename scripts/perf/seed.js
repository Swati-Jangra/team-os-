// Seeds a scratch database with a large dataset (300k tasks in one project, 300k audit rows, 100k notifications).
// Usage: PERF_DB_URL=postgresql://migrator:...@host/teamos_perf node scripts/perf/seed.js   (API must be running against that DB)
const { execSync } = require('child_process');
const B = (process.env.PERF_API ?? 'http://localhost:4400') + '/api/v1';
const DB = process.env.PERF_DB_URL; // migrator/owner connection string of a THROWAWAY database
if (!DB) { console.error('Set PERF_DB_URL to the owner connection string of a scratch database (never production).'); process.exit(1); }
const psql = (q) => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`, { maxBuffer: 1 << 28 }).toString().trim();
let cookie = '', csrf = '';
async function call(m, p, body) {
  const r = await fetch(B + p, { method: m, headers: { 'content-type': 'application/json', cookie, ...(csrf ? { 'x-csrf-token': csrf } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie?.() ?? [];
  if (sc.length) { const jar = Object.fromEntries(cookie.split('; ').filter(Boolean).map((c) => c.split('='))); for (const c of sc) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; if (k === 'teamos_csrf') csrf = decodeURIComponent(v); } cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${JSON.stringify(j)}`); return j.data;
}
(async () => {
  const email = `perf${Date.now()}@example.com`, password = 'correct-horse-battery-9';
  await call('POST', '/auth/register', { email, name: 'Perf User', password });
  const token = psql(`select payload->>'token' from outbox_events where type='user.email_verification_requested.v1' and payload->>'email'='${email}' order by created_at desc limit 1`);
  await call('POST', '/auth/verify-email', { token });
  await call('POST', '/auth/login', { email, password });
  const org = await call('POST', '/organizations', { name: 'Perf Org' });
  const ws = await call('POST', `/organizations/${org.id}/workspaces`, { name: 'Perf WS' });
  const proj = await call('POST', `/organizations/${org.id}/projects`, { workspaceId: ws.id, name: 'Big', key: 'BIG' });
  const me = await call('GET', '/auth/me');
  const O = org.id, W = ws.id, P = proj.id, U = me.user.id;
  console.log(JSON.stringify({ email, password, O, W, P, U }));
  const t0 = Date.now();
  // 300k tasks across the one project + 20 other projects
  psql(`insert into projects (organization_id, workspace_id, name, key, task_seq, created_by) select '${O}','${W}','P'||g, 'Q'||g, 0, '${U}' from generate_series(1,20) g`);
  psql(`insert into tasks (organization_id, workspace_id, project_id, number, title, status, priority, assignee_id, reporter_id, due_date, position, created_at, updated_at)
        select '${O}','${W}','${P}', g, 'Task number '||g||' '||md5(g::text), (array['TODO','IN_PROGRESS','IN_REVIEW','DONE','CANCELLED'])[1+g%5]::task_status, (array['LOW','MEDIUM','HIGH','URGENT'])[1+g%4]::task_priority,
        case when g%3=0 then '${U}'::uuid end, '${U}', current_date + (g%90), g, now() - (g||' minutes')::interval, now() from generate_series(1,300000) g`);
  psql(`update projects set task_seq=300000 where id='${P}'`);
  psql(`insert into tasks (organization_id, workspace_id, project_id, number, title, status, priority, reporter_id, position)
        select '${O}','${W}', p.id, g, 'Other '||g, 'TODO','MEDIUM','${U}', g from projects p cross join generate_series(1,5000) g where p.id<>'${P}' and p.organization_id='${O}'`);
  psql(`insert into audit_logs (organization_id, actor_type, actor_id, action, target_type, target_id, created_at) select '${O}','USER','${U}', (array['task.created','task.updated','project.updated'])[1+g%3], 'task', gen_random_uuid()::text, now() - (g||' seconds')::interval from generate_series(1,300000) g`);
  psql(`insert into notifications (organization_id, user_id, category, title, created_at) select '${O}','${U}','TASK_ASSIGNED','Notification '||g, now() - (g||' seconds')::interval from generate_series(1,100000) g`);
  console.log('seeded in', (Date.now() - t0) / 1000, 's');
})().catch((e) => { console.error(e.message); process.exit(1); });
