// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mutations, query, scenario } from '@/test/mocks';

vi.mock('@/features/org/org-context', () => ({ useOrgContext: () => ({ orgId: 'org1', can: (p: string) => scenario.permissions.has(p) }) }));
vi.mock('@/components/page', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/features/projects/api', () => ({ useProjects: () => query(scenario.projects) }));
vi.mock('@/features/google/api', () => ({
  useEmails: () => query({ items: scenario.emails, meta: { page: 1, totalPages: 1 } }),
  useEmail: () => query(scenario.email),
  useEmailMutations: () => ({
    approve: { ...mutations.approve, mutate: mutations.approve, isPending: false },
    reject: { ...mutations.reject, mutate: mutations.reject, isPending: false },
    editItem: { mutate: mutations.editItem },
    linkProject: { mutate: mutations.linkProject },
  }),
}));

import EmailsPage from './page';

const summary = { id: 'm1', subject: 'APO launch plan', fromAddress: 'boss@acme.io', receivedAt: new Date().toISOString(), projectKey: 'APO', pendingItems: 2, status: 'PROCESSED', workspaceId: 'ws1' };
const item = (over: object) => ({ id: 'i1', kind: 'ACTION_ITEM', text: 'Write release notes', status: 'PENDING', assigneeHint: 'Dana', dueDate: '2026-12-01', taskId: null, ...over });
const detail = (items: unknown[]) => ({ ...summary, excerpt: 'Hi team, Action: write release notes', summary: null, failureReason: null, projectId: 'p1', linkSource: 'AUTO', items });

beforeEach(() => {
  vi.clearAllMocks();
  scenario.permissions = new Set(['approval:decide', 'task:create']);
  scenario.emails = [summary];
  scenario.projects = [{ id: 'p1', name: 'Apollo', workspaceId: 'ws1' }, { id: 'p2', name: 'Other WS', workspaceId: 'ws9' }];
  scenario.email = detail([item({}), item({ id: 'i2', kind: 'DECISION', text: 'Ship on Friday' })]);
});

const open = async () => { render(<EmailsPage />); await userEvent.click(screen.getByRole('button', { name: /APO launch plan/ })); };

describe('Email page', () => {
  it('shows the empty state when nothing was ingested', () => {
    scenario.emails = [];
    render(<EmailsPage />);
    expect(screen.getByText('No email yet')).toBeInTheDocument();
  });

  it('lists messages with their project and the number of items awaiting review', () => {
    render(<EmailsPage />);
    expect(screen.getByText('APO')).toBeInTheDocument();
    expect(screen.getByText('2 to review')).toBeInTheDocument();
  });

  it('an action item cannot be approved until a project is chosen, and only offers projects of its own workspace', async () => {
    await open();
    const row = screen.getAllByTestId('email-item')[0]!;
    const approve = within(row).getByRole('button', { name: /approve & create task/i });
    const select = within(row).getByLabelText('Project for the new task') as HTMLSelectElement;
    // the message is already linked to p1 => preselected; clear it to prove the guard
    await userEvent.selectOptions(select, '');
    expect(approve).toBeDisabled();
    expect(within(select).queryByText('Other WS')).not.toBeInTheDocument();
    await userEvent.selectOptions(select, 'p1');
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(mutations.approve).toHaveBeenCalledWith({ id: 'm1', itemId: 'i1', projectId: 'p1' });
  });

  it('a decision is approved without a project and never creates a task from the UI side', async () => {
    await open();
    const row = screen.getAllByTestId('email-item')[1]!;
    expect(within(row).queryByLabelText('Project for the new task')).not.toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /^approve$/i }));
    expect(mutations.approve).toHaveBeenCalledWith({ id: 'm1', itemId: 'i2' });
  });

  it('reject calls the reject mutation', async () => {
    await open();
    await userEvent.click(within(screen.getAllByTestId('email-item')[0]!).getByRole('button', { name: /reject/i }));
    expect(mutations.reject).toHaveBeenCalledWith({ id: 'm1', itemId: 'i1' });
  });

  it('people without approval:decide can read items but get no approve/reject controls and a read-only text', async () => {
    scenario.permissions = new Set(['task:create']);
    await open();
    expect(screen.getAllByTestId('email-item')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Item text')).not.toBeInTheDocument();
    expect(screen.getByText('Write release notes')).toBeInTheDocument();
  });

  it('decided items are final: no controls, and an approved action shows that a task was created', async () => {
    scenario.email = detail([item({ status: 'APPROVED', taskId: 't1' }), item({ id: 'i2', status: 'REJECTED' })]);
    await open();
    expect(screen.queryByRole('button', { name: /approve|reject/i })).not.toBeInTheDocument();
    expect(screen.getByText('Task created from this item.')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
  });

  it('the project link selector is disabled without task:create', async () => {
    scenario.permissions = new Set();
    await open();
    expect(screen.getByLabelText('Project')).toBeDisabled();
  });
});
