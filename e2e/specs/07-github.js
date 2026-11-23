// Browser E2E (Playwright) against a running stack. See e2e/README.md.
const DB = process.env.E2E_DATABASE_URL; // schema-owner URL, used only to read outbox tokens and assert DB state
if (!DB) throw new Error('set E2E_DATABASE_URL');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const crypto = require('crypto');
const SP = process.argv[2] || 'e2e/out', BASE = 'http://localhost:3000', PW = 'Sup3rSecretPass1', MOCK = 'http://localhost:4510';
const psql = (q) => execSync(`psql "${DB}" -tAc "${q}"`).toString().trim();
const tok = (type, email) => { // poll: the outbox row is written by the API request itself
  for (let i = 0; i < 40; i++) { const v = psql(`select payload->>'token' from outbox_events where type='${type}' and payload->>'email'='${email}' order by created_at desc limit 1`); if (v) return v; execSync('sleep 0.5'); }
  throw new Error(`no outbox token for ${type} / ${email}`);
};
const ts = Date.now(), emailA = `gha${ts}@example.com`, emailB = `ghb${ts}@example.com`;
const step = (s) => console.log('✓', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, what) => { for (let i = 0; i < 60; i++) { if (await fn()) return; await sleep(500); } throw new Error('timeout: ' + what); };
const mock = async (p, init) => (await fetch(MOCK + p, init)).json();
async function signup(browser, name, email) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); p.errors = [];
  p.on('pageerror', (e) => p.errors.push('pageerror: ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/403|409|400|404|Failed to load resource/.test(m.text())) p.errors.push('console: ' + m.text()); });
  await p.goto(BASE + '/register');
  await p.getByLabel('Full name').fill(name); await p.getByLabel('Work email').fill(email); await p.getByLabel('Password', { exact: false }).first().fill(PW);
  await p.getByRole('button', { name: /create account/i }).click(); await sleep(1500);
  await p.goto(`${BASE}/verify-email?token=${tok('user.email_verification_requested.v1', email)}`);
  await p.getByText(/verified/i).first().waitFor();
  await p.goto(BASE + '/login'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW);
  await p.getByRole('button', { name: /sign in/i }).click(); await p.waitForURL(/onboarding\/organization/);
  return { ctx, p };
}
const csrf = async (ctx) => (await ctx.cookies()).find((c) => c.name === 'teamos_csrf').value;
(async () => {
  const browser = await chromium.launch();
  const A = await signup(browser, 'Alice Admin', emailA), B = await signup(browser, 'Bob Builder', emailB);
  const a = A.p, b = B.p;
  await a.getByLabel('Organization name').fill('Hook Co'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/onboarding\/workspace/); await a.getByLabel('Workspace name').fill('Product'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/dashboard/);
  const org = a.url().replace(/\/dashboard.*/, ''); const orgId = org.split('/o/')[1];
  const api = (ctx) => async (m, path, data) => { const r = await ctx.request[m](`${BASE}/api/v1/organizations/${orgId}${path}`, { headers: { 'x-csrf-token': await csrf(ctx) }, data }); return (await r.json()).data; };
  const A_ = api(A.ctx);
  const ws = (await A_('get', '/workspaces'))[0].id;
  const proj = await A_('post', '/projects', { workspaceId: ws, name: 'Apollo', key: 'APO' });
  const task = await A_('post', `/projects/${proj.id}/tasks`, { title: 'Login flow' });
  const taskKey = `APO-${task.number}`;
  await A_('post', '/invitations', { email: emailB, role: 'DEVELOPER', workspaceIds: [ws] }); await sleep(1500);
  await B.ctx.request.post(`${BASE}/api/v1/invitations/accept`, { headers: { 'x-csrf-token': await csrf(B.ctx) }, data: { token: tok('member.invited.v1', emailB) } });
  step('org, project, task and a developer member exist');

  // Developer: page is readable, but nothing to manage
  await b.goto(`${org}/integrations`); await b.getByText('Only owners and admins can connect').waitFor();
  if (await b.getByRole('button', { name: /connect github/i }).count()) throw new Error('developer sees Connect GitHub');
  step('Bob (Developer) sees the page without connect/disconnect controls');

  // OAuth through the mock
  await a.getByRole('link', { name: 'Integrations' }).click(); await a.waitForURL(/\/integrations$/);
  await a.screenshot({ path: `${SP}/shots/70-integrations-empty.png` });
  await a.getByRole('button', { name: 'Connect GitHub' }).click();
  await a.waitForURL(/integrations\?connected=github/); await a.getByText('Signed in as mock-octo').waitFor();
  step('OAuth round trip (authorize → callback → redirect) connected GitHub as mock-octo');
  const enc = psql(`select token_enc from integration_tokens where organization_id='${orgId}'`);
  if (enc.includes('gho_mock_token') || !enc.startsWith('v1:')) throw new Error('token not encrypted: ' + enc);
  const html = await a.content(); if (html.includes('gho_mock')) throw new Error('token leaked to the page');
  step('stored token is AES-GCM ciphertext and never reaches the browser');

  // Connect a repo
  await a.getByRole('button', { name: 'Connect repository' }).first().click();
  await a.locator('#repo-name').selectOption('acme/api'); await a.locator('#repo-ws').selectOption({ label: 'Product' });
  await a.getByRole('button', { name: 'Connect repository' }).last().click();
  await a.getByTestId('repo-row').waitFor();
  const hook = Object.entries((await mock('/__state')).hooks)[0]; if (!hook) throw new Error('no webhook created on GitHub');
  const [hookId, h] = hook; const repoId = h.url.split('/').pop();
  step(`repo connected; webhook created on GitHub → ${h.url.replace(/^https?:\/\/[^/]+/, '')}`);

  // Initial sync pulls a PR that mentions the task key
  await mock('/__pr', { method: 'POST', body: JSON.stringify({ number: 7, title: `${taskKey} implement login`, state: 'open', html_url: 'https://github.com/acme/api/pull/7', user: { login: 'bob' }, head: { ref: `feat/${taskKey.toLowerCase()}` }, updated_at: new Date().toISOString(), created_at: new Date().toISOString() }) });
  await a.getByRole('button', { name: /sync now/i }).click();
  await until(() => Number(psql(`select count(*) from external_items`)) >= 1, 'PR synced by worker');
  await a.reload(); await a.getByTestId('external-item').first().waitFor();
  if (!(await a.getByTestId('external-item').first().textContent()).includes(taskKey)) throw new Error('PR not auto-linked to ' + taskKey);
  step(`worker synced the PR and auto-linked it to ${taskKey}`);
  await a.screenshot({ path: `${SP}/shots/71-integrations-synced.png` });

  // Task drawer shows it
  await a.goto(`${org}/projects/${proj.id}`);
  await a.getByText('Login flow').first().click();
  await a.getByTestId('task-github-links').waitFor();
  if (!(await a.getByTestId('task-github-links').textContent()).includes('implement login')) throw new Error('drawer missing PR');
  step('task drawer lists the linked pull request');
  await a.screenshot({ path: `${SP}/shots/72-task-github-link.png` });

  // Signed webhook: merged
  const post = (body, secret, delivery, sig) => fetch(`${BASE}/api/v1/webhooks/github/${repoId}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'pull_request', 'x-github-delivery': delivery, 'x-hub-signature-256': sig ?? 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex') }, body });
  const payload = JSON.stringify({ action: 'closed', repository: { full_name: 'acme/api' }, pull_request: { number: 7, title: `${taskKey} implement login`, state: 'closed', merged: true, merged_at: new Date().toISOString(), html_url: 'https://github.com/acme/api/pull/7', user: { login: 'bob' }, head: { ref: 'x' }, updated_at: new Date().toISOString() } });
  if ((await post(payload, h.secret, 'e2e-bad', 'sha256=' + '0'.repeat(64))).status !== 401) throw new Error('bad signature accepted');
  if ((await post(payload, h.secret, 'e2e-1')).status !== 202) throw new Error('signed webhook rejected');
  const dup = await (await post(payload, h.secret, 'e2e-1')).json(); if (!dup.data.duplicate) throw new Error('redelivery not deduplicated');
  await until(() => psql(`select state from external_items where external_id='7' and repo_id='${repoId}'`) === 'merged', 'webhook processed -> merged');
  step('bad signature → 401; signed delivery → processed (PR now merged); redelivery deduplicated');
  await a.goto(`${org}/integrations`); await a.getByText('merged').first().waitFor();

  // Disconnect stops everything
  await a.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await a.getByRole('button', { name: 'Disconnect' }).last().click();
  await a.getByRole('button', { name: 'Connect GitHub' }).waitFor();
  if (psql(`select count(*) from integration_tokens where organization_id='${orgId}'`) !== '0') throw new Error('token survived disconnect');
  if (!(await mock('/__state')).deletedHooks.includes(Number(hookId))) throw new Error('webhook not removed on GitHub');
  if ((await post(payload, h.secret, 'e2e-after')).status !== 404) throw new Error('webhook accepted after disconnect');
  const before = (await mock('/__state')).calls; await sleep(1500);
  step('disconnect: token deleted, GitHub webhook removed, further deliveries get 404');
  await a.screenshot({ path: `${SP}/shots/73-integrations-disconnected.png` });
  const audit = psql(`select string_agg(action, ',' order by created_at) from audit_logs where action like 'integration.%'`);
  console.log('audit:', audit);
  for (const p of [a, b]) if (p.errors.length) throw new Error('browser errors: ' + p.errors.join(' | '));
  step('no browser console errors');
  await browser.close();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
