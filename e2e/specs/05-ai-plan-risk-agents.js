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
const ts = Date.now(), emailA = `mta${ts}@example.com`, emailB = `mtb${ts}@example.com`;
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

(async () => {
  const browser = await chromium.launch();
  const A = await signup(browser, 'Alice Admin', emailA), B = await signup(browser, 'Bob Builder', emailB);
  const a = A.p, b = B.p;
  await a.getByLabel('Organization name').fill('Meet Co'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/onboarding\/workspace/); await a.getByLabel('Workspace name').fill('Product'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/dashboard/);
  const org = a.url().replace(/\/dashboard.*/, ''); const orgId = org.split('/o/')[1];
  const hdr = { 'x-csrf-token': await csrf(A.ctx) };
  const wss = (await (await A.ctx.request.get(`${BASE}/api/v1/organizations/${orgId}/workspaces`)).json()).data;
  const ws1 = wss[0].id;
  const ws2 = (await (await A.ctx.request.post(`${BASE}/api/v1/organizations/${orgId}/workspaces`, { headers: hdr, data: { name: 'Finance' } })).json()).data.id;
  const proj = (await (await A.ctx.request.post(`${BASE}/api/v1/organizations/${orgId}/projects`, { headers: hdr, data: { workspaceId: ws1, name: 'Apollo', key: 'APO', description: 'Launch the onboarding flow' } })).json()).data;
  await A.ctx.request.post(`${BASE}/api/v1/organizations/${orgId}/invitations`, { headers: hdr, data: { email: emailB, role: 'DEVELOPER', workspaceIds: [ws2] } });
  await new Promise(r => setTimeout(r, 1500));
  await B.ctx.request.post(`${BASE}/api/v1/invitations/accept`, { headers: { 'x-csrf-token': await csrf(B.ctx) }, data: { token: tok('member.invited.v1', emailB) } });
  step('org, project Apollo in Product; Bob only in Finance');

  await a.getByRole('link', { name: 'Meetings' }).click(); await a.waitForURL(/\/meetings$/);
  await a.getByRole('button', { name: /new meeting/i }).first().click();
  const dlg = a.getByRole('dialog'); await dlg.getByLabel('Workspace').selectOption({ label: 'Product' }); await dlg.getByLabel('Title').fill('Weekly sync');
  await dlg.getByLabel(/Transcript/).fill('Decision: we ship the beta on Friday\nAction: Write the migration guide\nAction: Set up the staging database\nBlocker: Waiting on the vendor API key');
  await dlg.getByRole('button', { name: /create meeting/i }).click(); await a.waitForURL(/meetings\/[0-9a-f-]{36}/);
  step('meeting created with pasted transcript');
  await a.getByRole('button', { name: /process meeting/i }).click();
  await a.getByText('Ready for review').first().waitFor({ timeout: 30000 }); step('worker processed meeting; UI updated live to Ready');
  const items = a.getByTestId('meeting-item'); const n = await items.count(); if (n !== 4) throw new Error('expected 4 items, got ' + n);
  const tasksBefore = Number(psql(`select count(*) from tasks where organization_id='${orgId}'`)); if (tasksBefore !== 0) throw new Error('tasks exist before approval');
  await a.screenshot({ path: `${SP}/shots/50-meeting-review.png` });

  const first = items.nth(1); if (!(await first.locator('input').inputValue()).includes('migration')) throw new Error('unexpected item order');
  await first.getByLabel('Project for the new task').selectOption({ label: 'Apollo' });
  await first.getByRole('button', { name: /approve & create task/i }).click();
  await first.getByText('Task created from this item').waitFor(); step('approving an action item created a task');
  if (Number(psql(`select count(*) from tasks where organization_id='${orgId}'`)) !== 1) throw new Error('expected exactly 1 task');
  await items.nth(2).getByRole('button', { name: /reject/i }).click();
  await a.getByText('Rejected').first().waitFor();
  await items.nth(0).getByRole('button', { name: /^approve$/i }).click();
  await a.getByText('Approved').nth(1).waitFor().catch(() => {});
  if (Number(psql(`select count(*) from tasks where organization_id='${orgId}'`)) !== 1) throw new Error('rejecting/acknowledging must not create tasks'); step('reject and decision-acknowledge created no tasks');
  await a.screenshot({ path: `${SP}/shots/51-meeting-decided.png` });

  // other-workspace user
  await b.goto(`${org}/meetings`); await b.getByText('No meetings yet').waitFor(); step('Bob (Finance only) sees no Product meetings');

  // AI plan
  await a.goto(`${org}/projects/${proj.id}`);
  await a.getByRole('button', { name: /plan with ai/i }).click();
  const pd = a.getByRole('dialog'); await pd.getByLabel(/Goal/).fill('- Design the flow\n- Build the API\n- Write tests');
  await pd.getByRole('button', { name: /suggest tasks/i }).click();
  await pd.getByTestId('plan-task').first().waitFor();
  const before = Number(psql(`select count(*) from tasks where organization_id='${orgId}'`));
  await a.screenshot({ path: `${SP}/shots/52-plan-dialog.png` });
  const cnt = await pd.getByTestId('plan-task').count();
  await pd.getByRole('button', { name: /create \d+ task/i }).click(); await a.waitForTimeout(1500);
  const after = Number(psql(`select count(*) from tasks where organization_id='${orgId}'`)); if (after - before !== cnt) throw new Error(`plan created ${after - before}, expected ${cnt}`);
  step(`AI plan proposed ${cnt} tasks; none existed until confirmed; ${cnt} created after confirm`);
  for (const p of [a, b]) if (p.errors.length) throw new Error('browser errors: ' + p.errors.join(' | '));
  step('no browser errors'); await browser.close();
})().catch(e => { console.error('✗', e.message); process.exit(1); });
