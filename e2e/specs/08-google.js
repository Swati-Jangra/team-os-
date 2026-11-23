// Browser E2E (Playwright) against a running stack. See e2e/README.md.
const DB = process.env.E2E_DATABASE_URL; // schema-owner URL, used only to read outbox tokens and assert DB state
if (!DB) throw new Error('set E2E_DATABASE_URL');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const crypto = require('crypto');
const SP = process.argv[2] || 'e2e/out', BASE = 'http://localhost:3000', PW = 'Sup3rSecretPass1', MOCK = 'http://localhost:4520';
const psql = (q) => execSync(`psql "${DB}" -tAc "${q}"`).toString().trim();
const tok = (type, email) => { // poll: the outbox row is written by the API request itself
  for (let i = 0; i < 40; i++) { const v = psql(`select payload->>'token' from outbox_events where type='${type}' and payload->>'email'='${email}' order by created_at desc limit 1`); if (v) return v; execSync('sleep 0.5'); }
  throw new Error(`no outbox token for ${type} / ${email}`);
};
const ts = Date.now(), emailA = `gga${ts}@example.com`, emailB = `ggb${ts}@example.com`;
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

const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
const post = (p, b) => mock(p, { method: 'POST', body: JSON.stringify(b) });
(async () => {
  const browser = await chromium.launch();
  const A = await signup(browser, 'Alice Admin', emailA), B = await signup(browser, 'Bob Builder', emailB);
  const a = A.p, b = B.p;
  await a.getByLabel('Organization name').fill('Goog Co'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/onboarding\/workspace/); await a.getByLabel('Workspace name').fill('Product'); await a.getByRole('button', { name: /create/i }).click();
  await a.waitForURL(/dashboard/);
  const org = a.url().replace(/\/dashboard.*/, ''); const orgId = org.split('/o/')[1];
  const api = (ctx) => async (m, path, data) => { const r = await ctx.request[m](`${BASE}/api/v1/organizations/${orgId}${path}`, { headers: { 'x-csrf-token': await csrf(ctx) }, data }); return (await r.json()).data; };
  const A_ = api(A.ctx);
  const ws = (await A_('get', '/workspaces'))[0].id;
  const proj = await A_('post', '/projects', { workspaceId: ws, name: 'Apollo', key: 'APO' });
  await A_('post', '/invitations', { email: emailB, role: 'DEVELOPER', workspaceIds: [ws] }); await sleep(1500);
  await B.ctx.request.post(`${BASE}/api/v1/invitations/accept`, { headers: { 'x-csrf-token': await csrf(B.ctx) }, data: { token: tok('member.invited.v1', emailB) } });
  const meeting = await A_('post', '/meetings', { workspaceId: ws, title: 'Weekly sync' });
  step('org, project, meeting and a developer member exist');

  // ---- Google Calendar
  await post('/__event', { id: 'e1', summary: 'Design review', start: { dateTime: iso(60) }, end: { dateTime: iso(120) }, attendees: [{ email: 'x@y.z' }, { email: 'p@q.r' }], htmlLink: 'https://calendar.google.com/e1' });
  await post('/__event', { id: 'e2', summary: 'Standup', start: { dateTime: iso(90) }, end: { dateTime: iso(105) } });
  await post('/__event', { id: 'e3', summary: 'Lunch', start: { dateTime: iso(300) }, end: { dateTime: iso(360) } });
  await a.goto(`${org}/integrations`);
  await a.getByRole('button', { name: 'Connect Google Calendar' }).click();
  await a.waitForURL(/integrations\?connected=google/); await a.getByText('Connected as me@example.com').waitFor();
  step('Google Calendar OAuth round trip connected the account (read-only calendar scope)');
  const scopes = psql(`select scopes from integrations where organization_id='${orgId}' and provider='GOOGLE_CALENDAR'`);
  if (scopes !== 'https://www.googleapis.com/auth/calendar.readonly') throw new Error('unexpected scope ' + scopes);
  const enc = psql(`select token_enc from integration_tokens t join integrations i on i.id=t.integration_id where i.organization_id='${orgId}' and i.provider='GOOGLE_CALENDAR'`);
  if (/at-cal|rt-cal/.test(enc) || !enc.startsWith('v1:')) throw new Error('google token not encrypted');
  if ((await a.content()).match(/at-cal|rt-cal/)) throw new Error('token leaked to page');
  step('access + refresh token stored as ciphertext only');

  await a.getByRole('button', { name: 'Connect calendar' }).click();
  await a.locator('#gcal-id').selectOption('team@example.com'); await a.locator('#gcal-ws').selectOption({ label: 'Product' });
  await a.getByRole('button', { name: 'Connect calendar' }).last().click();
  await a.getByTestId('calendar-source').waitFor();
  await until(() => Number(psql(`select count(*) from calendar_events where organization_id='${orgId}'`)) === 3, 'events synced');
  step('worker synced 3 events from the connected calendar');
  await a.screenshot({ path: `${SP}/shots/80-google-integrations.png` });

  await a.getByRole('link', { name: 'Calendar' }).click(); await a.waitForURL(/\/calendar$/);
  await a.getByTestId('calendar-event').first().waitFor();
  const txt = await a.locator('main').textContent();
  if (!/Design review/.test(txt) || !/Lunch/.test(txt)) throw new Error('events missing: ' + txt);
  if ((await a.getByText('Overlaps another event').count()) !== 2) throw new Error('expected the two overlapping events to be flagged');
  step('Calendar page lists events and flags the two overlapping ones');
  await a.screenshot({ path: `${SP}/shots/81-calendar.png` });

  await a.getByTestId('calendar-event').filter({ hasText: 'Design review' }).getByRole('button', { name: /link meeting/i }).click();
  await a.locator('#lm-meeting').selectOption({ label: 'Weekly sync' });
  await a.getByRole('button', { name: 'Link meeting', exact: true }).last().click();
  await a.getByTestId('calendar-event').filter({ hasText: 'Design review' }).getByRole('link', { name: 'Meeting notes' }).waitFor();
  if (psql(`select held_at is not null from meetings where id='${meeting.id}'`) !== 't') throw new Error('held_at not set from the event');
  step('linked a meeting to a calendar event (meeting date now comes from the calendar)');

  // incremental sync: Lunch cancelled, Standup renamed
  await post('/__event', { id: 'e3', status: 'cancelled' });
  await post('/__event', { id: 'e2', summary: 'Standup (moved)', start: { dateTime: iso(200) }, end: { dateTime: iso(215) } });
  await a.goto(`${org}/integrations`);
  await a.getByTestId('calendar-source').getByRole('button', { name: /sync now/i }).click();
  await until(() => psql(`select string_agg(title, '|' order by title) from calendar_events where organization_id='${orgId}'`) === 'Design review|Standup (moved)', 'incremental sync applied');
  step('incremental sync (sync token) applied a cancellation and an edit');

  // developer sees the calendar read-only
  await b.goto(`${org}/calendar`); await b.getByTestId('calendar-event').first().waitFor();
  if (await b.getByRole('button', { name: /link meeting/i }).count()) throw new Error('developer can link meetings');
  step('Bob (Developer) sees the calendar without link controls');

  // ---- Gmail
  await post('/__message', { id: 'g1', subject: 'APO launch plan', body: 'Hi team,\nDecision: ship on Friday\nAction: Dana to write the release notes by 2026-12-01\n\nThanks' });
  await a.goto(`${org}/integrations`);
  await a.getByRole('button', { name: 'Connect Gmail' }).click();
  await a.waitForURL(/integrations\?connected=google/); await a.getByText('Connected as box@example.com').waitFor();
  await a.getByRole('button', { name: 'Connect label' }).click();
  await a.locator('#gm-ws').selectOption({ label: 'Product' }); await a.locator('#gm-proj').selectOption({ label: 'Apollo' });
  await a.getByRole('button', { name: 'Connect mailbox' }).click();
  await a.getByTestId('mail-source').waitFor();
  await until(() => Number(psql(`select count(*) from email_items where organization_id='${orgId}'`)) === 2, 'mail ingested + extracted');
  if (psql(`select count(*) from tasks where organization_id='${orgId}'`) !== '0') throw new Error('AI created a task by itself');
  step('Gmail label connected; worker ingested the message and PROPOSED 2 items (no task created)');
  const linked = psql(`select p.key||'/'||m.link_source from email_messages m join projects p on p.id=m.project_id where m.organization_id='${orgId}'`);
  if (linked !== 'APO/AUTO') throw new Error('email not auto-linked: ' + linked);
  step('email auto-linked to APO (task key in subject)');

  await a.getByRole('link', { name: 'Email' }).click(); await a.waitForURL(/\/emails$/);
  await a.getByTestId('email-message').first().click();
  await a.getByTestId('email-item').first().waitFor();
  if (!(await a.getByTestId('email-excerpt').textContent()).includes('release notes')) throw new Error('excerpt missing');
  await a.screenshot({ path: `${SP}/shots/82-emails.png` });
  const action = a.getByTestId('email-item').filter({ hasText: 'Action item' });
  await action.getByLabel('Project for the new task').selectOption({ label: 'Apollo' });
  await action.getByRole('button', { name: /approve & create task/i }).click();
  await until(() => psql(`select count(*) from tasks where organization_id='${orgId}'`) === '1', 'task created by approval');
  step('approving the action item created exactly one task');
  const dec = a.getByTestId('email-item').filter({ hasText: 'Decision' });
  await dec.getByRole('button', { name: /^approve$/i }).click();
  await dec.getByText('Approved').waitFor();
  if (psql(`select count(*) from tasks where organization_id='${orgId}'`) !== '1') throw new Error('decision created a task');
  step('approving a decision recorded it without creating a task');
  await a.screenshot({ path: `${SP}/shots/83-email-approved.png` });

  await b.goto(`${org}/emails`); await b.getByTestId('email-message').first().click(); await b.getByTestId('email-item').first().waitFor();
  if (await b.getByRole('button', { name: /approve/i }).count()) throw new Error('developer sees approve controls');
  step('Bob (Developer) can read the email but cannot approve or reject');

  // ---- disconnect
  await a.goto(`${org}/integrations`);
  await a.getByTestId('google-mail-card').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await a.getByRole('button', { name: 'Disconnect' }).last().click();
  await a.getByTestId('google-mail-card').getByRole('button', { name: 'Connect Gmail' }).waitFor();
  if (psql(`select count(*) from integration_tokens t join integrations i on i.id=t.integration_id where i.organization_id='${orgId}' and i.provider='GOOGLE_MAIL'`) !== '0') throw new Error('mail token survived');
  if (!(await mock('/__state')).revoked.includes('rt-mail')) throw new Error('refresh token not revoked at Google');
  if (psql(`select count(*) from email_sources where organization_id='${orgId}' and active`) !== '0') throw new Error('mailbox still active');
  await post('/__message', { id: 'g2', subject: 'after disconnect', body: 'Decision: should never be read' });
  await a.goto(`${org}/integrations`);
  await sleep(1500);
  if (Number(psql(`select count(*) from email_messages where organization_id='${orgId}'`)) !== 1) throw new Error('mail ingested after disconnect');
  step('Gmail disconnect: token deleted, grant revoked at Google, mailbox inactive, later mail never read');
  console.log('audit:', psql(`select string_agg(distinct action, ',') from audit_logs where organization_id='${orgId}' and (action like 'integration.%' or action like 'email.%' or action like 'meeting.calendar%')`));
  for (const p of [a, b]) if (p.errors.length) throw new Error('browser errors: ' + p.errors.join(' | '));
  step('no browser console errors');
  await browser.close();
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
