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
const ts = Date.now(), emailA = `kda${ts}@example.com`, emailB = `kdb${ts}@example.com`;
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
  await a.getByLabel('Organization name').fill('Know Co'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/onboarding\/workspace/); await a.getByLabel('Workspace name').fill('Product'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/dashboard/);
  const org = a.url().replace(/\/dashboard.*/, ''); const orgId = org.split('/o/')[1];
  // second workspace + invite Bob to it only
  const csrfA = await csrf(A.ctx);
  const ws2 = (await (await A.ctx.request.post(`${BASE}/api/v1/organizations/${orgId}/workspaces`, { headers: { 'x-csrf-token': csrfA }, data: { name: 'Finance' } })).json()).data.id;
  await A.ctx.request.post(`${BASE}/api/v1/organizations/${orgId}/invitations`, { headers: { 'x-csrf-token': csrfA }, data: { email: emailB, role: 'DEVELOPER', workspaceIds: [ws2] } });
  await new Promise(r => setTimeout(r, 1500));
  await B.ctx.request.post(`${BASE}/api/v1/invitations/accept`, { headers: { 'x-csrf-token': await csrf(B.ctx) }, data: { token: tok('member.invited.v1', emailB) } });
  step('org with Product (Alice) and Finance (Alice + Bob); Bob has no access to Product');

  // --- create + edit a document in the UI
  await a.getByRole('link', { name: 'Documents' }).click(); await a.waitForURL(/\/documents$/);
  await a.getByRole('button', { name: /new document/i }).first().click();
  const dlg = a.getByRole('dialog'); await dlg.getByLabel('Workspace').selectOption({ label: 'Product' }); await dlg.getByLabel('Title').fill('Launch plan');
  await dlg.getByRole('button', { name: /create document/i }).click(); await a.waitForURL(/documents\/[0-9a-f-]{36}/);
  const docUrl = a.url();
  const editor = a.getByRole('textbox', { name: 'Document body' }); await editor.click();
  await a.keyboard.type('The canary release starts on Monday for ten percent of customers. Rollback uses the blue green switch.');
  await a.getByRole('button', { name: 'Heading' }).click().catch(() => {});
  await a.getByRole('button', { name: /^save$/i }).click(); await a.getByRole('button', { name: /saved/i }).waitFor(); step('document written and saved (v2)');
  await a.screenshot({ path: `${SP}/shots/40-doc-editor.png` });
  await waitChunks('Launch plan'); step('worker indexed the document');

  // --- search + ask
  await a.getByRole('link', { name: 'Knowledge search' }).click();
  await a.getByLabel('Search or ask').fill('canary release monday');
  await a.getByRole('button', { name: 'Search', exact: true }).click();
  await a.getByRole('list', { name: 'Search results' }).getByText('Launch plan').waitFor(); step('keyword search finds the document');
  await a.getByLabel('Search or ask').fill('When does the canary release start?');
  await a.getByRole('button', { name: /ask ai/i }).click();
  await a.getByTestId('answer').waitFor(); const ans = await a.getByTestId('answer').textContent();
  if (!/\[1\]/.test(ans)) throw new Error('no citation in answer: ' + ans); step('Ask AI answered with a citation: ' + ans.slice(0, 80) + '…');
  await a.getByRole('list', { name: 'Sources' }).getByText('Launch plan').waitFor();
  await a.screenshot({ path: `${SP}/shots/41-knowledge-answer.png` });

  // --- permission: Bob cannot see Product's content
  await b.goto(`${org}/knowledge`);
  await b.getByLabel('Search or ask').fill('canary release monday'); await b.getByRole('button', { name: 'Search', exact: true }).click();
  await b.getByText('No results').waitFor(); step("Bob (Finance only) gets no results for Alice's Product document");
  await b.getByLabel('Search or ask').fill('When does the canary release start?'); await b.getByRole('button', { name: /ask ai/i }).click();
  await b.getByText(/could not find anything relevant/i).waitFor(); step('Bob’s AI answer has no Product sources');
  const bd = await b.request.get(docUrl.replace(BASE, BASE + '/api/v1').replace('/o/', '/organizations/'));
  console.log('  Bob direct API read of the document ->', bd.status());
  await b.screenshot({ path: `${SP}/shots/42-knowledge-no-access.png` });

  // --- version history + restore
  await a.goto(docUrl); await a.getByRole('textbox', { name: 'Document body' }).click();
  await a.keyboard.press('Control+End'); await a.keyboard.type(' EXTRA LINE added in v3.');
  await a.getByRole('button', { name: /^save$/i }).click(); await a.getByRole('button', { name: /saved/i }).waitFor();
  await a.getByRole('button', { name: 'History' }).click();
  await a.getByRole('button', { name: /^v2\b/ }).click();
  await a.getByText('Read-only preview').waitFor();
  await a.getByRole('button', { name: /restore this version/i }).click();
  await a.getByText(/Version 4/).first().waitFor({ timeout: 8000 }); step('restored v2 as a new version (v4); history kept');
  if ((await a.getByRole('textbox', { name: 'Document body' }).textContent()).includes('EXTRA LINE')) throw new Error('editor still shows v3 content after restore');
  await a.getByRole('button', { name: /saved/i }).waitFor(); step('editor shows restored content and is not dirty');
  await a.screenshot({ path: `${SP}/shots/43-version-history.png` });

  // --- stale edit detection + live follow
  const a2 = await A.ctx.newPage(); await a2.goto(docUrl); await a2.getByRole('textbox', { name: 'Document body' }).click(); await a2.keyboard.press('Control+End'); await a2.keyboard.type(' second tab edit');
  await a.getByRole('textbox', { name: 'Document body' }).click(); await a.keyboard.press('Control+End'); await a.keyboard.type(' local unsaved');
  await a2.getByRole('button', { name: /^save$/i }).click(); await a2.getByRole('button', { name: /saved/i }).waitFor();
  await a.getByRole('alert').getByText(/newer version/i).waitFor({ timeout: 15000 }); step('unsaved editor shows a stale-edit warning when another tab saves (live update)');
  await a.screenshot({ path: `${SP}/shots/44-stale-warning.png` });
  await a.getByRole('button', { name: /discard mine/i }).click(); await a.getByText(/second tab edit/).waitFor(); step('reload latest shows the other edit');

  // --- top-bar search
  await a.goto(`${org}/dashboard`); await a.getByLabel('Search knowledge').fill('blue green switch'); await a.keyboard.press('Enter');
  await a.waitForURL(/knowledge\?q=/); await a.getByRole('list', { name: 'Search results' }).getByText('Launch plan').first().waitFor(); step('top-bar search opens knowledge results');

  // --- delete removes it from search
  await a.goto(docUrl); await a.getByRole('button', { name: 'Delete document' }).click(); await a.getByRole('button', { name: 'Delete document', exact: true }).last().click();
  await a.waitForURL(/\/documents$/);
  await a.goto(`${org}/knowledge`); await a.getByLabel('Search or ask').fill('canary release monday'); await a.getByRole('button', { name: 'Search', exact: true }).click();
  await a.getByText('No results').waitFor(); step('deleted document disappears from search');
  for (let i = 0; i < 30 && Number(psql("select count(*) from knowledge_chunks where source_title='Launch plan'")) > 0; i++) await new Promise(r => setTimeout(r, 500));
  console.log('  chunks left after delete:', psql("select count(*) from knowledge_chunks where source_title='Launch plan'"));
  await a.setViewportSize({ width: 390, height: 844 }); await a.goto(`${org}/documents`); await a.waitForTimeout(600); await a.screenshot({ path: `${SP}/shots/45-docs-mobile.png` });
  console.log('ERRORS A:', JSON.stringify(a.errors), 'B:', JSON.stringify(b.errors));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 10).join('\n')); process.exit(1); });
