// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mutations, query, scenario } from '@/test/mocks';

vi.mock('next/link', () => ({ default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a> }));
vi.mock('@/features/org/org-context', () => ({ useOrgContext: () => ({ orgId: 'org1', can: (p: string) => scenario.permissions.has(p) }) }));
vi.mock('@/components/page', () => ({ PageHeader: ({ title }: { title: string }) => <h1>{title}</h1> }));
vi.mock('@/features/org/api', () => ({ useWorkspaces: () => query([{ id: 'ws1', name: 'Product' }]) }));
vi.mock('@/features/meetings/api', () => ({ useMeetings: () => query({ items: scenario.meetings }) }));
vi.mock('@/features/google/api', () => ({
  useCalendarEvents: () => query(scenario.events),
  useCalendarLinkMutations: () => ({
    link: { mutateAsync: mutations.link, isPending: false },
    unlink: { mutate: mutations.unlink },
  }),
}));

import CalendarPage from './page';

const start = (h: number) => new Date(Date.UTC(2026, 10, 24, h, 0)).toISOString();
const ev = (over: object) => ({ id: 'e1', title: 'Design review', startsAt: start(9), endsAt: start(10), allDay: false, status: 'confirmed', attendeeCount: 3, conflict: false, meetingId: null, workspaceId: 'ws1', htmlLink: 'https://calendar.google.com/e1', ...over });

beforeEach(() => {
  vi.clearAllMocks();
  scenario.permissions = new Set(['meeting:manage']);
  scenario.meetings = [{ id: 'mt1', title: 'Weekly sync' }];
  scenario.events = [ev({}), ev({ id: 'e2', title: 'Standup', conflict: true })];
});

describe('Calendar page', () => {
  it('shows the empty state when there are no events', () => {
    scenario.events = [];
    render(<CalendarPage />);
    expect(screen.getByText('No upcoming events')).toBeInTheDocument();
  });

  it('lists events and flags only the overlapping one', () => {
    render(<CalendarPage />);
    expect(screen.getAllByTestId('calendar-event')).toHaveLength(2);
    expect(screen.getAllByText('Overlaps another event')).toHaveLength(1);
    expect(within(screen.getAllByTestId('calendar-event')[1]!).getByText('Overlaps another event')).toBeInTheDocument();
    expect(screen.getAllByText('3 attendees')).toHaveLength(2);
  });

  it('only offers meeting linking to people with meeting:manage', () => {
    render(<CalendarPage />);
    expect(screen.getAllByRole('button', { name: /link meeting/i })).toHaveLength(2);
  });

  it('read-only users see the events but no link or unlink controls', () => {
    scenario.permissions = new Set();
    scenario.events = [ev({}), ev({ id: 'e2', title: 'Standup', meetingId: 'mt9' })];
    render(<CalendarPage />);
    expect(screen.queryByRole('button', { name: /link meeting|unlink/i })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Meeting notes' })).toHaveAttribute('href', '/o/org1/meetings/mt9');
  });

  it('linking requires choosing a meeting, then sends the event and meeting ids', async () => {
    mutations.link.mockResolvedValue(undefined);
    render(<CalendarPage />);
    await userEvent.click(within(screen.getAllByTestId('calendar-event')[0]!).getByRole('button', { name: /link meeting/i }));
    const submit = await screen.findByRole('button', { name: 'Link meeting' });
    expect(submit).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Meeting'), 'mt1');
    expect(submit).toBeEnabled();
    await userEvent.click(submit);
    expect(mutations.link).toHaveBeenCalledWith({ meetingId: 'mt1', eventId: 'e1' });
  });

  it('unlinking calls the unlink mutation for that meeting', async () => {
    scenario.events = [ev({ meetingId: 'mt9' })];
    render(<CalendarPage />);
    await userEvent.click(screen.getByRole('button', { name: /unlink design review/i }));
    expect(mutations.unlink).toHaveBeenCalledWith('mt9');
  });

  it('only renders http(s) event links, opened safely', () => {
    scenario.events = [ev({ htmlLink: 'javascript:alert(1)' }), ev({ id: 'e2', title: 'Ok', htmlLink: 'https://calendar.google.com/ok' })];
    render(<CalendarPage />);
    const links = screen.getAllByRole('link', { name: /open .* in google calendar/i });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
