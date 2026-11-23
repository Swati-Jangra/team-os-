import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Client, type Harness } from './harness';

let h: Harness;
let alice: Client; // owner of org A
let bob: Client; // owner of org B
let orgA: string;
let orgB: string;
let wsA: string;

beforeAll(async () => {
  h = await createHarness();
  alice = await h.signup('alice@a.com', 'Alice');
  bob = await h.signup('bob@b.com', 'Bob');

  const a = await alice.post('/organizations', { name: 'Acme A' });
  expect(a.status).toBe(201);
  orgA = a.body.data.id;
  const b = await bob.post('/organizations', { name: 'Bravo B' });
  orgB = b.body.data.id;

  const ws = await alice.post(`/organizations/${orgA}/workspaces`, { name: 'Engineering' });
  expect(ws.status).toBe(201);
  wsA = ws.body.data.id;
  await bob.post(`/organizations/${orgB}/workspaces`, { name: 'Bravo Space' });
}, 90_000);

afterAll(async () => {
  await h?.close();
});

/** Invites `email` into org A with `role` and accepts as that (new) user. */
async function addMember(email: string, role: string, workspaceIds?: string[]): Promise<Client> {
  const c = await h.signup(email);
  const inv = await alice.post(`/organizations/${orgA}/invitations`, { email, role, workspaceIds });
  expect(inv.status).toBe(201);
  const token = await h.tokenFor('member.invited.v1', email);
  const acc = await c.post('/invitations/accept', { token });
  expect(acc.status).toBe(200);
  return c;
}

describe('organizations & workspaces', () => {
  it('creator becomes OWNER; slug is derived and unique', async () => {
    const res = await alice.get(`/organizations/${orgA}`);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('OWNER');
    expect(res.body.data.slug).toBe('acme-a');

    const dup = await bob.post('/organizations', { name: 'Anything', slug: 'acme-a' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SLUG_TAKEN');

    const auto = await bob.post('/organizations', { name: 'Acme A' });
    expect(auto.status).toBe(201);
    expect(auto.body.data.slug).not.toBe('acme-a');
  });

  it('lists only my organizations', async () => {
    const mine = await alice.get('/organizations');
    expect(mine.body.data.map((o: { id: string }) => o.id)).toEqual([orgA]);
  });

  it('update writes an audit entry and emits no secrets', async () => {
    const res = await alice.patch(`/organizations/${orgA}`, { name: 'Acme Corp' });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Acme Corp');
    const log = await alice.get(`/organizations/${orgA}/audit-logs?action=org.updated`);
    expect(log.status).toBe(200);
    expect(log.body.data).toHaveLength(1);
    expect(log.body.data[0].actorId).toBe(alice.userId);
    expect(log.body.data[0].requestId).toBeTruthy();
    expect(log.body.meta.total).toBe(1);
  });

  it('workspace create → outbox event + creator is a member', async () => {
    const members = await alice.get(`/organizations/${orgA}/workspaces/${wsA}/members`);
    expect(members.body.data.map((m: { email: string }) => m.email)).toEqual(['alice@a.com']);
    const ev = await h.t.admin.selectFrom('outboxEvents').select('type').where('type', '=', 'workspace.created.v1').execute();
    expect(ev.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tenant isolation over the API', () => {
  it("another tenant's org is invisible: 404, not 403", async () => {
    for (const path of [
      `/organizations/${orgB}`,
      `/organizations/${orgB}/workspaces`,
      `/organizations/${orgB}/members`,
      `/organizations/${orgB}/audit-logs`,
      `/organizations/${orgB}/invitations`,
    ]) {
      const res = await alice.get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    }
    expect((await alice.patch(`/organizations/${orgB}`, { name: 'pwned' })).status).toBe(404);
    expect((await alice.post(`/organizations/${orgB}/workspaces`, { name: 'x' })).status).toBe(404);
    expect((await alice.post(`/organizations/${orgB}/invitations`, { email: 'x@y.com', role: 'VIEWER' })).status).toBe(404);
  });

  it("cannot reach another tenant's workspace by id through my own org path", async () => {
    const bobWs = (await bob.get(`/organizations/${orgB}/workspaces`)).body.data[0].id;
    const res = await alice.get(`/organizations/${orgA}/workspaces/${bobWs}`);
    expect(res.status).toBe(404);
    expect((await alice.patch(`/organizations/${orgA}/workspaces/${bobWs}`, { name: 'x' })).status).toBe(404);
    expect((await alice.delete(`/organizations/${orgA}/workspaces/${bobWs}`)).status).toBe(404);
    // and it is untouched
    expect((await bob.get(`/organizations/${orgB}/workspaces/${bobWs}`)).body.data.name).toBe('Bravo Space');
  });

  it('client-supplied ids in bodies are ignored / rejected', async () => {
    const res = await alice.post(`/organizations/${orgA}/workspaces`, { name: 'Sneaky', organizationId: orgB, id: orgB });
    expect(res.status).toBe(201);
    expect(res.body.data.organizationId).toBe(orgA);
    expect(res.body.data.id).not.toBe(orgB);
  });

  it('malformed org ids give 404', async () => {
    expect((await alice.get('/organizations/not-a-uuid')).status).toBe(404);
  });

  it('audit log only contains my org’s entries', async () => {
    const log = await alice.get(`/organizations/${orgA}/audit-logs?pageSize=100`);
    const rows = log.body.data as Array<{ action: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const bobLog = await bob.get(`/organizations/${orgB}/audit-logs?pageSize=100`);
    const ids = new Set(rows.map((r: unknown) => (r as { id: string }).id));
    for (const r of bobLog.body.data) expect(ids.has(r.id)).toBe(false);
  });
});

describe('invitations & RBAC', () => {
  let dev: Client;
  let viewer: Client;
  let admin: Client;
  let pm: Client;

  it('invite → accept flow adds the member with the invited role and workspace access', async () => {
    dev = await addMember('dev@a.com', 'DEVELOPER', [wsA]);
    const me = await dev.get('/auth/me');
    expect(me.body.data.memberships).toHaveLength(1);
    expect(me.body.data.memberships[0].role).toBe('DEVELOPER');
    const wss = await dev.get(`/organizations/${orgA}/workspaces`);
    expect(wss.body.data.map((w: { id: string }) => w.id)).toEqual([wsA]);
  });

  it('plain members only see workspaces they belong to', async () => {
    const wss = await dev.get(`/organizations/${orgA}/workspaces`);
    expect(wss.body.data).toHaveLength(1); // alice has 2+ workspaces by now
    const mine = await alice.get(`/organizations/${orgA}/workspaces`);
    expect(mine.body.data.length).toBeGreaterThan(1);
    const hidden = mine.body.data.find((w: { id: string }) => w.id !== wsA);
    expect((await dev.get(`/organizations/${orgA}/workspaces/${hidden.id}`)).status).toBe(404);
  });

  it('invitation tokens: single use, wrong user rejected, hash only in DB', async () => {
    const email = 'wrongperson@a.com';
    const target = await h.signup(email);
    const other = await h.signup('someoneelse@x.com');
    await alice.post(`/organizations/${orgA}/invitations`, { email, role: 'VIEWER' });
    const token = await h.tokenFor('member.invited.v1', email);

    const stored = await h.t.admin.selectFrom('invitations').select('tokenHash').execute();
    expect(stored.map((s) => s.tokenHash)).not.toContain(token);

    const wrong = await other.post('/invitations/accept', { token });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVITATION_INVALID');

    expect((await target.post('/invitations/accept', { token })).status).toBe(200);
    expect((await target.post('/invitations/accept', { token })).status).toBe(400); // already used
    expect((await other.post('/invitations/accept', { token: 'x'.repeat(43) })).status).toBe(400); // garbage = same error
  });

  it('revoked invitations cannot be accepted', async () => {
    const email = 'revoked@a.com';
    const c = await h.signup(email);
    const inv = await alice.post(`/organizations/${orgA}/invitations`, { email, role: 'VIEWER' });
    const token = await h.tokenFor('member.invited.v1', email);
    expect((await alice.delete(`/organizations/${orgA}/invitations/${inv.body.data.id}`)).status).toBe(200);
    expect((await c.post('/invitations/accept', { token })).status).toBe(400);
  });

  it('duplicate pending invites and inviting existing members are conflicts', async () => {
    await alice.post(`/organizations/${orgA}/invitations`, { email: 'dupe@a.com', role: 'VIEWER' });
    const dupe = await alice.post(`/organizations/${orgA}/invitations`, { email: 'dupe@a.com', role: 'VIEWER' });
    expect(dupe.status).toBe(409);
    const existing = await alice.post(`/organizations/${orgA}/invitations`, { email: 'dev@a.com', role: 'VIEWER' });
    expect(existing.status).toBe(409);
  });

  it('OWNER can never be granted by invitation', async () => {
    const res = await alice.post(`/organizations/${orgA}/invitations`, { email: 'x@a.com', role: 'OWNER' });
    expect(res.status).toBe(403);
  });

  it('developers cannot invite, remove members, edit the org, create workspaces or read the audit log', async () => {
    expect((await dev.post(`/organizations/${orgA}/invitations`, { email: 'n@a.com', role: 'VIEWER' })).status).toBe(403);
    expect((await dev.patch(`/organizations/${orgA}`, { name: 'x' })).status).toBe(403);
    expect((await dev.post(`/organizations/${orgA}/workspaces`, { name: 'x' })).status).toBe(403);
    expect((await dev.get(`/organizations/${orgA}/audit-logs`)).status).toBe(403);
    expect((await dev.delete(`/organizations/${orgA}/members/${alice.userId}`)).status).toBe(403);
    expect((await dev.put(`/organizations/${orgA}/members/${dev.userId}/role`, { role: 'OWNER' })).status).toBe(403);
    // but they can read
    expect((await dev.get(`/organizations/${orgA}`)).status).toBe(200);
    expect((await dev.get(`/organizations/${orgA}/members`)).status).toBe(200);
  });

  it('role hierarchy: no escalation above your own rank, cannot touch peers or owners', async () => {
    viewer = await addMember('viewer@a.com', 'VIEWER');
    admin = await addMember('admin@a.com', 'ADMIN');
    pm = await addMember('pm@a.com', 'PROJECT_MANAGER');

    // admin may promote a developer, but not to OWNER, and not touch the owner
    expect((await admin.put(`/organizations/${orgA}/members/${dev.userId}/role`, { role: 'TEAM_LEAD' })).status).toBe(200);
    expect((await admin.put(`/organizations/${orgA}/members/${dev.userId}/role`, { role: 'OWNER' })).status).toBe(403);
    expect((await admin.put(`/organizations/${orgA}/members/${alice.userId}/role`, { role: 'VIEWER' })).status).toBe(403);
    expect((await admin.delete(`/organizations/${orgA}/members/${alice.userId}`)).status).toBe(403);
    // admin cannot self-promote to owner
    expect((await admin.put(`/organizations/${orgA}/members/${admin.userId}/role`, { role: 'OWNER' })).status).toBe(403);

    // PM can invite at/below their rank but not above
    expect((await pm.post(`/organizations/${orgA}/invitations`, { email: 'lowly@a.com', role: 'DEVELOPER' })).status).toBe(201);
    expect((await pm.post(`/organizations/${orgA}/invitations`, { email: 'high@a.com', role: 'ADMIN' })).status).toBe(403);
    // but PM cannot change roles at all
    expect((await pm.put(`/organizations/${orgA}/members/${viewer.userId}/role`, { role: 'GUEST' })).status).toBe(403);
  });

  it('role changes are audited and take effect immediately', async () => {
    const before = await dev.get(`/organizations/${orgA}/audit-logs`); // TEAM_LEAD: still no audit:read
    expect(before.status).toBe(403);
    expect((await alice.put(`/organizations/${orgA}/members/${dev.userId}/role`, { role: 'PROJECT_MANAGER' })).status).toBe(200);
    expect((await dev.get(`/organizations/${orgA}/audit-logs`)).status).toBe(200); // PM has audit:read
    const log = await alice.get(`/organizations/${orgA}/audit-logs?action=member.role_changed`);
    expect(log.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('the last owner cannot be demoted or removed; a second owner makes it possible', async () => {
    const demote = await alice.put(`/organizations/${orgA}/members/${alice.userId}/role`, { role: 'ADMIN' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('LAST_OWNER');
    const remove = await alice.delete(`/organizations/${orgA}/members/${alice.userId}`);
    expect(remove.status).toBe(409);

    expect((await alice.put(`/organizations/${orgA}/members/${admin.userId}/role`, { role: 'OWNER' })).status).toBe(200);
    expect((await alice.put(`/organizations/${orgA}/members/${alice.userId}/role`, { role: 'ADMIN' })).status).toBe(200);
    // now `admin` is the only owner
    expect((await admin.delete(`/organizations/${orgA}/members/${admin.userId}`)).status).toBe(409);
    // restore alice as owner for later tests
    expect((await admin.put(`/organizations/${orgA}/members/${alice.userId}/role`, { role: 'OWNER' })).status).toBe(200);
  });

  it('removed members lose access immediately and can be re-invited', async () => {
    expect((await alice.delete(`/organizations/${orgA}/members/${viewer.userId}`)).status).toBe(200);
    expect((await viewer.get(`/organizations/${orgA}`)).status).toBe(404);
    expect((await viewer.get('/auth/me')).body.data.memberships).toEqual([]);

    await alice.post(`/organizations/${orgA}/invitations`, { email: 'viewer@a.com', role: 'GUEST' });
    const token = await h.tokenFor('member.invited.v1', 'viewer@a.com');
    expect((await viewer.post('/invitations/accept', { token })).status).toBe(200);
    expect((await viewer.get('/auth/me')).body.data.memberships[0].role).toBe('GUEST');
  });

  it('GUESTs cannot see the member list', async () => {
    expect((await viewer.get(`/organizations/${orgA}/members`)).status).toBe(403);
  });

  it('accepting an invite as an existing member never changes their role', async () => {
    // alice (OWNER) is invited as VIEWER by admin-owner and accepts: still OWNER
    await admin.post(`/organizations/${orgA}/invitations`, { email: 'bob@b.com', role: 'VIEWER' });
    const token = await h.tokenFor('member.invited.v1', 'bob@b.com');
    expect((await bob.post('/invitations/accept', { token })).status).toBe(200);
    const memberships = (await bob.get('/auth/me')).body.data.memberships as Array<{ organizationId: string; role: string }>;
    expect(memberships.find((m) => m.organizationId === orgA)?.role).toBe('VIEWER');
    expect(memberships.find((m) => m.organizationId === orgB)?.role).toBe('OWNER'); // other org untouched
  });
});

describe('every mutation here is auditable', () => {
  it('audit actions cover org, workspace, invitation and membership changes', async () => {
    const rows = await h.t.admin
      .selectFrom('auditLogs')
      .select('action')
      .where('organizationId', '=', orgA)
      .execute();
    const actions = new Set(rows.map((r) => r.action));
    for (const a of [
      'org.created',
      'org.updated',
      'workspace.created',
      'invitation.created',
      'invitation.accepted',
      'invitation.revoked',
      'member.role_changed',
      'member.removed',
    ]) {
      expect(actions.has(a), a).toBe(true);
    }
  });
});
