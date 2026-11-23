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
const email = `p2owner${Date.now()}@example.com`;
const step = (s) => console.log('✓', s);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage(); const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/403|409|400/.test(m.text())) errors.push('console: ' + m.text()); });
  await p.goto(BASE + '/register');
  await p.getByLabel('Full name').fill('Priya Planner'); await p.getByLabel('Work email').fill(email); await p.getByLabel('Password', { exact: false }).first().fill(PW);
  await p.getByRole('button', { name: /create account/i }).click(); await p.waitForTimeout(1500);
  await p.goto(`${BASE}/verify-email?token=${tok('user.email_verification_requested.v1', email)}`);
  await p.getByText(/verified/i).first().waitFor();
  await p.goto(BASE + '/login'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW);
  await p.getByRole('button', { name: /sign in/i }).click(); await p.waitForURL(/onboarding\/organization/);
  await p.getByLabel('Organization name').fill('Nimbus Labs'); await p.getByRole('button', { name: /create/i }).click();
  await p.waitForURL(/onboarding\/workspace/); await p.getByLabel('Workspace name').fill('Product'); await p.getByRole('button', { name: /create/i }).click();
  await p.waitForURL(/dashboard/); step('signed up, org + workspace ready');
  const org = p.url().replace(/\/dashboard.*/, '');

  await p.getByRole('link', { name: 'Projects' }).click(); await p.waitForURL(/\/projects$/);
  await p.screenshot({ path: `${SP}/shots/20-projects-empty.png` });
  await p.getByRole('button', { name: /new project/i }).first().click();
  const pd = p.getByRole('dialog');
  await pd.getByLabel('Workspace').selectOption({ label: 'Product' });
  await pd.getByLabel('Project name').fill('Mobile App Launch');
  await pd.getByLabel('Start').fill('2026-11-16'); await pd.getByLabel('Due').fill('2026-12-20');
  await pd.getByRole('button', { name: /create project/i }).click();
  await p.getByText('Mobile App Launch').first().waitFor(); step('project created (key derived)');
  await p.screenshot({ path: `${SP}/shots/21-projects.png` });
  await p.getByText('Mobile App Launch').first().click(); await p.waitForURL(/projects\/[0-9a-f-]{36}/);

  // add tasks on the board
  const add = async (col, title) => {
    await p.getByRole('listitem', { name: col }).getByRole('button', { name: /add task/i }).click();
    await p.getByLabel(`New task in ${col}`).fill(title); await p.keyboard.press('Enter');
    await p.getByRole('listitem', { name: col }).getByText(title).waitFor();
  };
  await add('To do', 'Design onboarding flow'); await p.getByRole('button', { name: 'Cancel' }).click();
  await add('To do', 'Build login screen'); await p.getByRole('button', { name: 'Cancel' }).click();
  await add('Backlog', 'Write release notes'); await p.getByRole('button', { name: 'Cancel' }).click();
  step('3 tasks added on board');

  // drag "Design onboarding flow" to In progress
  await p.getByText('Design onboarding flow').dragTo(p.getByRole('listitem', { name: 'In progress' }));
  await p.getByRole('listitem', { name: 'In progress' }).getByText('Design onboarding flow').waitFor(); step('drag & drop changed status');
  await p.reload(); await p.getByRole('listitem', { name: 'In progress' }).getByText('Design onboarding flow').waitFor(); step('status persisted after reload');

  // open drawer, edit
  await p.getByText('Build login screen').click();
  const dlg = p.getByRole('dialog');
  await dlg.getByLabel('Priority').selectOption('HIGH');
  await dlg.getByLabel('Start date').fill('2026-11-18'); await dlg.getByLabel('Due date').fill('2026-11-25');
  await dlg.getByLabel('Assignee').selectOption({ label: 'Priya Planner' });
  await dlg.getByLabel('Add dependency').selectOption({ index: 1 }); await dlg.getByRole('button', { name: 'Add', exact: true }).click();
  await dlg.getByText(/Blocked by 1 unfinished/).waitFor(); step('priority/dates/assignee/dependency saved');
  // blocked -> done must fail
  await dlg.getByLabel('Status').selectOption('DONE');
  await p.getByText(/blocked by unfinished tasks/i).waitFor({ timeout: 5000 }); step('completing a blocked task is rejected with a clear message');
  await dlg.getByLabel('Write a comment').fill('Waiting on design handoff.'); await dlg.getByRole('button', { name: 'Comment', exact: true }).click();
  await dlg.getByText('Waiting on design handoff.').waitFor(); step('comment posted');
  await p.waitForTimeout(600); await p.screenshot({ path: `${SP}/shots/22-task-drawer.png` });
  await p.keyboard.press('Escape'); await p.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });

  // give the first task dates for timeline
  await p.getByText('Design onboarding flow').click();
  await p.getByRole('dialog').getByLabel('Start date').fill('2026-11-16'); await p.getByRole('dialog').getByLabel('Due date').fill('2026-11-20');
  await p.waitForTimeout(800); await p.keyboard.press('Escape'); await p.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 });

  await p.screenshot({ path: `${SP}/shots/23-board.png` });
  await p.getByRole('tab', { name: 'List' }).click(); await p.getByText('Write release notes').waitFor(); await p.screenshot({ path: `${SP}/shots/24-list.png` });
  await p.getByRole('tab', { name: 'Milestones' }).click();
  await p.getByLabel('Milestone name').fill('Beta release'); await p.getByLabel('Milestone due date').fill('2026-12-01'); await p.getByRole('button', { name: /^add$/i }).click();
  await p.getByText('Beta release').waitFor(); step('milestone created');
  await p.getByRole('tab', { name: 'Timeline' }).click(); await p.waitForTimeout(800); await p.screenshot({ path: `${SP}/shots/25-timeline.png` });
  await p.getByRole('tab', { name: 'Activity' }).click(); await p.getByText(/created the project/).waitFor(); await p.screenshot({ path: `${SP}/shots/26-activity.png` });
  await p.getByRole('link', { name: 'My tasks' }).click(); await p.getByText('Build login screen').waitFor(); step('my tasks lists assigned task');
  await p.screenshot({ path: `${SP}/shots/27-my-tasks.png` });
  // dark + mobile
  await p.goto(org + '/projects'); await p.evaluate(() => localStorage.setItem('theme', 'dark')); await p.getByText('Mobile App Launch').first().click();
  await p.reload(); await p.waitForTimeout(1200); await p.screenshot({ path: `${SP}/shots/28-board-dark.png` });
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(500); await p.screenshot({ path: `${SP}/shots/29-board-mobile.png` });
  console.log('ERRORS:', JSON.stringify(errors, null, 1));
  await browser.close();
})().catch(e => { console.error('FAIL', e.message.split('\n').slice(0, 8).join('\n')); process.exit(1); });
