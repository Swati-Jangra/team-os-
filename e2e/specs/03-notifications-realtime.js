// Browser E2E (Playwright) against a running stack. See e2e/README.md.
const DB = process.env.E2E_DATABASE_URL; // schema-owner URL, used only to read outbox tokens and assert DB state
if (!DB) throw new Error('set E2E_DATABASE_URL');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const SP = process.argv[2] || 'e2e/out', BASE = 'http://localhost:3000', PW = 'Sup3rSecretPass1';
const tok = (type, email) => { // the outbox row is written by the API request; poll instead of sleeping a fixed time
  for (let i = 0; i < 40; i++) { const v = execSync(`psql "${DB}" -tAc "select payload->>'token' from outbox_events where type='${type}' and payload->>'email'='${email}' order by created_at desc limit 1"`).toString().trim(); if (v) return v; execSync('sleep 0.5'); }
  throw new Error(`no outbox token for ${type} / ${email}`);
};
const ts = Date.now(), emailA = `rta${ts}@example.com`, emailB = `rtb${ts}@example.com`;
const step = (s) => console.log('✓', s);
const mails = () => Number((require('fs').readFileSync(`${SP}/smtp.log`, 'utf8').match(/MAIL \d+/g) || ['MAIL 0']).pop().split(' ')[1]);
async function signup(browser, name, email, vp) {
  const ctx = await browser.newContext({ viewport: vp });
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
(async () => {
  const browser = await chromium.launch();
  const A = await signup(browser, 'Alice Admin', emailA, { width: 1440, height: 900 });
  const B = await signup(browser, 'Bob Builder', emailB, { width: 1440, height: 900 });
  const a = A.p, b = B.p;
  await a.getByLabel('Organization name').fill('Live Co'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/onboarding\/workspace/); await a.getByLabel('Workspace name').fill('Product'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/dashboard/);
  const org = a.url().replace(/\/dashboard.*/, ''); const orgId = org.split('/o/')[1];
  step('A: org + workspace');
  // invite B via API from A's session, B accepts via API
  const ws = (await (await A.ctx.request.get(`${BASE}/api/v1/organizations/${orgId}/workspaces`)).json()).data[0].id;
  const inv = await A.ctx.request.post(`${BASE}/api/v1/organizations/${orgId}/invitations`, { headers: { 'x-csrf-token': await csrf(A.ctx) }, data: { email: emailB, role: 'DEVELOPER', workspaceIds: [ws] } });
  if (inv.status() !== 201) throw new Error('invite ' + inv.status());
  await new Promise(r => setTimeout(r, 1500));
  const acc = await B.ctx.request.post(`${BASE}/api/v1/invitations/accept`, { headers: { 'x-csrf-token': await csrf(B.ctx) }, data: { token: tok('member.invited.v1', emailB) } });
  if (acc.status() !== 200) throw new Error('accept ' + acc.status());
  step('B joined as developer');

  await a.goto(`${org}/projects`);
  await a.getByRole('button', { name: /new project/i }).first().click();
  const pd = a.getByRole('dialog'); await pd.getByLabel('Workspace').selectOption({ label: 'Product' }); await pd.getByLabel('Project name').fill('Realtime Demo');
  await pd.getByRole('button', { name: /create project/i }).click(); await a.getByText('Realtime Demo').first().click(); await a.waitForURL(/projects\/[0-9a-f-]{36}/);
  const projUrl = a.url();
  await a.getByRole('listitem', { name: 'To do' }).getByRole('button', { name: /add task/i }).click();
  await a.getByLabel('New task in To do').fill('Ship the beta'); await a.keyboard.press('Enter');
  await a.getByRole('listitem', { name: 'To do' }).getByText('Ship the beta').waitFor();
  await a.getByRole('button', { name: 'Cancel' }).click(); step('A: project + task');

  await b.goto(projUrl); await b.getByRole('listitem', { name: 'To do' }).getByText('Ship the beta').waitFor(); step('B sees the board');
  await b.waitForTimeout(1500); // let the SSE connect

  // A assigns task to B
  const mailsBefore = mails();
  await a.getByText('Ship the beta').click();
  await a.getByRole('dialog').getByLabel('Assignee').selectOption({ label: 'Bob Builder' });
  await a.waitForTimeout(500); await a.keyboard.press('Escape'); await a.getByRole('dialog').waitFor({ state: 'detached' });
  await b.getByTestId('unread-badge').waitFor({ timeout: 15000 }); step('B: bell badge appeared live (no reload)');
  await b.getByText(/Alice Admin assigned you/).first().waitFor({ timeout: 5000 }); step('B: toast shown');
  await b.screenshot({ path: `${SP}/shots/30-live-toast.png` });
  await new Promise(r => setTimeout(r, 2500));
  console.log('  emails sent after assign:', mails() - mailsBefore);

  // A drags to In progress -> B board updates live
  await a.getByText('Ship the beta').dragTo(a.getByRole('listitem', { name: 'In progress' }));
  await b.getByRole('listitem', { name: 'In progress' }).getByText('Ship the beta').waitFor({ timeout: 15000 }); step('B: board moved the card live (no reload)');

  // A comments
  await a.getByText('Ship the beta').click();
  await a.getByRole('dialog').getByLabel('Write a comment').fill('Looks great, please finish today.');
  await a.getByRole('dialog').getByRole('button', { name: 'Comment', exact: true }).click(); await a.getByRole('dialog').getByText('Looks great').waitFor();
  await a.keyboard.press('Escape');
  await b.waitForFunction(() => /^[3-9]/.test(document.querySelector('[data-testid=unread-badge]')?.textContent || ''), null, { timeout: 15000 }); step('B: unread count grew to ≥3 (assigned, status, comment)');

  // B opens the bell
  await b.getByRole('button', { name: /Notifications, \d+ unread/ }).click();
  await b.getByText(/commented on/).first().waitFor();
  await b.screenshot({ path: `${SP}/shots/31-bell-open.png` });
  await b.getByText(/commented on/).first().click();
  await b.waitForURL(/task=/); step('B: clicking a notification deep-links to the task');
  await b.keyboard.press('Escape');

  await b.goto(`${org}/notifications`); await b.getByText(/assigned you/).first().waitFor();
  await b.screenshot({ path: `${SP}/shots/32-notifications-inbox.png` });
  await b.getByRole('button', { name: /mark all read/i }).first().click();
  await b.getByTestId('unread-badge').waitFor({ state: 'detached', timeout: 8000 }); step('B: mark all read clears the badge');
  await b.getByRole('tab', { name: 'Preferences' }).click();
  await b.getByLabel('Assigned to me: email').uncheck(); await b.getByRole('button', { name: /save preferences/i }).click();
  await b.getByText(/preferences saved/i).waitFor(); await b.reload(); await b.getByRole('tab', { name: 'Preferences' }).click();
  if (await b.getByLabel('Assigned to me: email').isChecked()) throw new Error('pref not persisted'); step('B: preference persisted');
  await b.screenshot({ path: `${SP}/shots/33-notification-prefs.png` });
  await b.evaluate(() => localStorage.setItem('theme', 'dark')); await b.reload(); await b.getByRole('tab', { name: 'Preferences' }).click(); await b.waitForTimeout(600);
  await b.screenshot({ path: `${SP}/shots/34-prefs-dark.png` });
  await b.setViewportSize({ width: 390, height: 844 }); await b.goto(`${org}/notifications`); await b.waitForTimeout(800); await b.screenshot({ path: `${SP}/shots/35-inbox-mobile.png` });

  // Remove B: B's stream should close and further access fail
  const rm = await A.ctx.request.delete(`${BASE}/api/v1/organizations/${orgId}/members/${(await (await B.ctx.request.get(BASE + '/api/v1/auth/me')).json()).data.user.id}`, { headers: { 'x-csrf-token': await csrf(A.ctx) } });
  console.log('  remove B status', rm.status());
  console.log('ERRORS A:', JSON.stringify(a.errors), 'B:', JSON.stringify(b.errors));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 10).join('\n')); process.exit(1); });
