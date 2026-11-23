// Browser E2E (Playwright) against a running stack. See e2e/README.md.
const DB = process.env.E2E_DATABASE_URL; // schema-owner URL, used only to read outbox tokens and assert DB state
if (!DB) throw new Error('set E2E_DATABASE_URL');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const SP = process.argv[2] || 'e2e/out', BASE = 'http://localhost:3000', PW = 'Sup3rSecretPass1';
const psql = (q) => execSync(`psql "${DB}" -tAc "${q}"`).toString().trim();
const tok = (type, email) => { // poll: the outbox row is written by the API request itself
  for (let i = 0; i < 40; i++) { const v = psql(`select payload->>'token' from outbox_events where type='${type}' and payload->>'email'='${email}' order by created_at desc limit 1`); if (v) return v; execSync('sleep 0.5'); }
  throw new Error(`no outbox token for ${type} / ${email}`);
};
const ts = Date.now(), emailA = `rka${ts}@example.com`, emailB = `rkb${ts}@example.com`;
const step = (s) => console.log('✓', s);
async function signup(browser, name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); p.errors = [];
  p.on('pageerror', e => p.errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/403|409|400|404|Failed to load resource/.test(m.text())) p.errors.push('console: ' + m.text()); });
  await p.goto(BASE + '/register');
  await p.getByLabel('Full name').fill(name); await p.getByLabel('Work email').fill(email); await p.getByLabel('Password', { exact: false }).first().fill(PW);
  await p.getByRole('button', { name: /create account/i }).click(); await p.waitForTimeout(1500);
  await p.goto(`${BASE}/verify-email?token=${tok('user.email_verification_requested.v1', email)}`);
  await p.getByText(/verified/i).first().waitFor();
  await p.goto(BASE + '/login'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW);
  await p.getByRole('button', { name: /sign in/i }).click(); await p.waitForURL(/onboarding\/organization/);
  return { ctx, p };
}
const csrf = async (ctx) => (await ctx.cookies()).find(c => c.name === 'teamos_csrf').value;
const waitChunks = async (title, n = 1) => { for (let i = 0; i < 40; i++) { if (Number(psql(`select count(*) from knowledge_chunks where source_title='${title}'`)) >= n) return; await new Promise(r => setTimeout(r, 500)); } throw new Error('indexing timeout for ' + title); };

const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
(async () => {
  const browser = await chromium.launch();
  const A = await signup(browser, 'Alice Admin', emailA), B = await signup(browser, 'Bob Builder', emailB);
  const a = A.p, b = B.p;
  await a.getByLabel('Organization name').fill('Risk Co'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/onboarding\/workspace/); await a.getByLabel('Workspace name').fill('Product'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/dashboard/);
  const org = a.url().replace(/\/dashboard.*/, ''); const orgId = org.split('/o/')[1];
  const api = (ctx) => async (m, path, data) => { const h = { 'x-csrf-token': await csrf(ctx) }; const r = await ctx.request[m](`${BASE}/api/v1/organizations/${orgId}${path}`, { headers: h, data }); return (await r.json()).data; };
  const A_ = api(A.ctx), B_ = api(B.ctx);
  const ws = (await A_('get', '/workspaces'))[0].id;
  const proj = await A_('post', '/projects', { workspaceId: ws, name: 'Apollo', key: 'APO' });
  await A_('post', '/invitations', { email: emailB, role: 'DEVELOPER', workspaceIds: [ws] });
  await new Promise(r => setTimeout(r, 1500));
  await B.ctx.request.post(`${BASE}/api/v1/invitations/accept`, { headers: { 'x-csrf-token': await csrf(B.ctx) }, data: { token: tok('member.invited.v1', emailB) } });
  const me = (await (await A.ctx.request.get(`${BASE}/api/v1/auth/me`)).json()).data.user.id;
  const mk = (title, due, extra = {}) => A_('post', `/projects/${proj.id}/tasks`, { title, dueDate: due, ...extra });
  const t1 = await mk('Backend API', day(-5), { assigneeId: me }), t2 = await mk('Integration', day(2), { assigneeId: me }), t3 = await mk('Release', day(9), { assigneeId: me }), t4 = await mk('Docs', day(3));
  await A_('post', `/tasks/${t2.id}/dependencies`, { dependsOnTaskId: t1.id }); await A_('post', `/tasks/${t3.id}/dependencies`, { dependsOnTaskId: t2.id });
  step('project with an overdue task, a dependency chain and an unassigned task');
  const due = (id) => psql(`select due_date from tasks where id='${id}'`);

  await a.getByRole('link', { name: 'Risk center' }).click(); await a.waitForURL(/\/risks$/);
  await a.getByTestId('finding').first().waitFor();
  const txt = await a.getByTestId('project-risk').textContent();
  if (!/overdue/.test(txt) || !/Fact/.test(txt) || !/Inferred/.test(txt)) throw new Error('risk center missing fact/inferred findings: ' + txt);
  step('Risk center shows overdue (Fact) and downstream slip (Inferred) findings');
  await a.screenshot({ path: `${SP}/shots/60-risk-center.png` });
  await b.goto(`${org}/approvals`); await b.getByText('Nothing here').waitFor();
  await a.getByRole('button', { name: /propose fixes/i }).click();
  await a.getByText(/waiting for approval/i).first().waitFor();
  if (due(t2.id) !== day(2)) throw new Error('proposal changed data'); step('agents proposed fixes; no task was changed');

  await b.getByTestId('agent-action').first().waitFor({ timeout: 15000 }); step('Bob’s open Approval center updated live with the new proposals');
  if (await b.getByRole('button', { name: /^approve$/i }).count()) throw new Error('developer sees Approve button'); step('Bob (Developer) can read proposals but has no approve/reject controls');
  await a.getByRole('link', { name: 'Approvals' }).click(); await a.waitForURL(/\/approvals$/);
  await a.getByTestId('agent-action').first().waitFor();
  await a.screenshot({ path: `${SP}/shots/61-approvals-pending.png` });
  const before = await a.getByTestId('agent-action').count();

  const card = (re) => a.getByTestId('agent-action').filter({ hasText: re }).first();
  await card(/Integration/).getByRole('button', { name: /^approve$/i }).click();
  await a.getByText('Approved and applied.').waitFor();
  if (due(t2.id) !== day(7)) throw new Error('expected due moved +5 days, got ' + due(t2.id)); step('approving moved Integration’s due date by the 5-day slip');
  await card(/Release/).getByRole('button', { name: /reject/i }).click();
  await a.getByText(/Rejected. Nothing was changed/).waitFor();
  if (due(t3.id) !== day(9)) throw new Error('rejected action changed data'); step('rejecting changed nothing');

  // stale: change Docs after it was proposed, then approve
  await A_('patch', `/tasks/${t4.id}`, { title: 'Docs (edited)' });
  await a.getByTestId('agent-action').filter({ hasText: /Assign task/ }).first().getByRole('button', { name: /^approve$/i }).click();
  await a.getByText(/task changed after this was proposed/i).first().waitFor();
  if (psql(`select coalesce(assignee_id::text,'none') from tasks where id='${t4.id}'`) !== 'none') throw new Error('stale approval applied');
  step('approval of a changed task was refused as out of date and applied nothing');
  await a.getByRole('tab', { name: 'All' }).click(); await a.waitForTimeout(800);
  await a.screenshot({ path: `${SP}/shots/62-approvals-all.png` });
  const audits = Number(psql(`select count(*) from audit_logs where organization_id='${orgId}' and action like 'agent_action.%'`));
  if (audits < 6) throw new Error('missing audit rows: ' + audits); step(`audit trail has ${audits} agent_action entries`);
  for (const p of [a, b]) if (p.errors.length) throw new Error('browser errors: ' + p.errors.join(' | '));
  step('no browser errors'); await browser.close();
})().catch(e => { console.error('✗', e.message); process.exit(1); });
