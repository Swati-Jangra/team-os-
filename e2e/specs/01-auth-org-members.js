// Browser E2E (Playwright) against a running stack. See e2e/README.md.
const DB = process.env.E2E_DATABASE_URL; // schema-owner URL, used only to read outbox tokens and assert DB state
if (!DB) throw new Error('set E2E_DATABASE_URL');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const SP = process.argv[2] || 'e2e/out';
const BASE = 'http://localhost:3000';
const PW = 'Sup3rSecretPass1';
const tok = (type, email) => { // the outbox row is written by the API request; poll instead of sleeping a fixed time
  for (let i = 0; i < 40; i++) { const v = execSync(`psql "${DB}" -tAc "select payload->>'token' from outbox_events where type='${type}' and payload->>'email'='${email}' order by created_at desc limit 1"`).toString().trim(); if (v) return v; execSync('sleep 0.5'); }
  throw new Error(`no outbox token for ${type} / ${email}`);
};
const stamp = Date.now();
const owner = `owner${stamp}@example.com`, mate = `mate${stamp}@example.com`;
(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }); const p = await ctx.newPage(); p.on('pageerror', e => errors.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); }); return p; };
  const step = (s) => console.log('✓', s);
  const A = await mk();
  await A.goto(BASE + '/register');
  await A.getByLabel('Full name').fill('Olivia Owner'); await A.getByLabel('Work email').fill(owner); await A.getByLabel('Password', { exact: false }).first().fill(PW);
  await A.screenshot({ path: `${SP}/shots/01-register.png` });
  await A.getByRole('button', { name: /create account|sign up|register/i }).click();
  await A.waitForTimeout(1500); step('registered');
  await A.goto(`${BASE}/verify-email?token=${tok('user.email_verification_requested.v1', owner)}`);
  await A.getByText(/verified/i).first().waitFor({ timeout: 8000 }); step('email verified');
  await A.goto(BASE + '/login');
  await A.getByLabel('Email').fill(owner); await A.getByLabel('Password').fill(PW);
  await A.getByRole('button', { name: /sign in|log in/i }).click();
  await A.waitForURL(/onboarding\/organization/, { timeout: 10000 }); step('logged in → org onboarding');
  await A.getByLabel('Organization name').fill('Acme Robotics');
  await A.getByRole('button', { name: /create/i }).click();
  await A.waitForURL(/onboarding\/workspace/, { timeout: 10000 }); step('org created');
  await A.getByLabel('Workspace name').fill('Platform Engineering');
  await A.getByRole('button', { name: /create/i }).click();
  await A.waitForURL(/dashboard/, { timeout: 10000 }); step('workspace created → dashboard');
  await A.waitForTimeout(1200);
  await A.screenshot({ path: `${SP}/shots/02-dashboard-light.png` });
  const orgUrl = A.url().replace(/\/dashboard.*/, '');
  // invite
  await A.goto(orgUrl + '/members');
  await A.getByRole('button', { name: /invite teammate/i }).click();
  await A.getByLabel('Email').fill(mate);
  await A.screenshot({ path: `${SP}/shots/03-invite-dialog.png` });
  await A.getByRole('button', { name: /send invitation/i }).click();
  await A.getByText(mate).first().waitFor({ timeout: 8000 }); step('invitation created');
  await A.screenshot({ path: `${SP}/shots/04-members.png` });
  // teammate
  const B = await mk();
  await B.goto(BASE + '/register');
  await B.getByLabel('Full name').fill('Marcus Mate'); await B.getByLabel('Work email').fill(mate); await B.getByLabel('Password', { exact: false }).first().fill(PW);
  await B.getByRole('button', { name: /create account|sign up|register/i }).click(); await B.waitForTimeout(1500);
  await B.goto(`${BASE}/verify-email?token=${tok('user.email_verification_requested.v1', mate)}`);
  await B.getByText(/verified/i).first().waitFor({ timeout: 8000 });
  await B.goto(BASE + '/login'); await B.getByLabel('Email').fill(mate); await B.getByLabel('Password').fill(PW);
  await B.getByRole('button', { name: /sign in|log in/i }).click(); await B.waitForTimeout(2000);
  await B.goto(`${BASE}/accept-invite?token=${tok('member.invited.v1', mate)}`);
  await B.getByRole('button', { name: /accept/i }).click();
  await B.waitForURL(/\/o\/.*\/(dashboard|onboarding)/, { timeout: 10000 }); step('invite accepted');
  await B.waitForTimeout(1200);
  await B.screenshot({ path: `${SP}/shots/05-mate-dashboard.png` });
  // owner pages
  await A.goto(orgUrl + '/members'); await A.getByText('Marcus Mate').first().waitFor(); step('new member visible to owner');
  await A.goto(orgUrl + '/workspaces'); await A.screenshot({ path: `${SP}/shots/06-workspaces.png` });
  await A.getByText('Platform Engineering').first().click(); await A.waitForTimeout(1200); await A.screenshot({ path: `${SP}/shots/07-workspace-detail.png` });
  await A.goto(orgUrl + '/roles'); await A.waitForTimeout(500); await A.screenshot({ path: `${SP}/shots/08-roles.png` });
  await A.goto(orgUrl + '/audit-logs'); await A.waitForTimeout(1200); await A.screenshot({ path: `${SP}/shots/09-audit.png` });
  await A.goto(orgUrl + '/settings'); await A.waitForTimeout(800); await A.screenshot({ path: `${SP}/shots/10-settings.png` });
  // dark
  await A.goto(orgUrl + '/dashboard'); await A.evaluate(() => { localStorage.setItem('theme', 'dark'); }); await A.reload(); await A.waitForTimeout(1500);
  await A.screenshot({ path: `${SP}/shots/11-dashboard-dark.png` });
  await A.setViewportSize({ width: 390, height: 844 }); await A.waitForTimeout(500); await A.screenshot({ path: `${SP}/shots/12-dashboard-mobile.png` });
  console.log('ERRORS:', JSON.stringify(errors, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0,6).join('\n')); process.exit(1); });
