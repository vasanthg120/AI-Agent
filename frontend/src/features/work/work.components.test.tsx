import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TeamDashboard, WorkDay, WorkTask } from '@/services/workAutomationService';
import { renderWithProviders } from '@/test/renderWithProviders';

vi.mock('@/services/workAutomationService', async (orig) => {
  const actual = await orig<typeof import('@/services/workAutomationService')>();
  return {
    ...actual,
    workAutomationService: {
      syncMe: vi.fn(async () => ({})),
      syncMeNow: vi.fn(async () => ({})),
      myDay: vi.fn(),
      myActivity: vi.fn(async () => []),
      myReports: vi.fn(async () => []),
      userDay: vi.fn(),
      act: vi.fn(),
      team: vi.fn(),
      report: vi.fn(),
      deliveries: vi.fn(async () => []),
    },
  };
});
vi.mock('@/stores/authStore', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel({ user: { id: 'u1' } }) }));
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import { workAutomationService as api } from '@/services/workAutomationService';
import { MyWorkPage } from './MyWorkPage';
import { TeamWorkPage } from './TeamWorkPage';
import { WorkTaskRow } from './WorkTaskRow';
import { EodReportView } from './EodReportView';

const task = (over: Partial<WorkTask> = {}): WorkTask => ({
  id: 't1',
  assignedTo: 'u1',
  title: 'Reply to Asha: Quote please',
  priority: 'high',
  status: 'pending',
  effectiveStatus: 'pending',
  sourcePlatform: 'outlook',
  sourceType: 'email_reply_owed',
  sourceRecordId: 'm1',
  sourceUrl: '/ai-email-inbox',
  ...over,
});

const day = (over: Partial<WorkDay> = {}): WorkDay => ({
  userId: 'u1',
  date: '2026-11-24',
  timezone: 'Asia/Kolkata',
  open: [],
  overdue: [],
  completed: [],
  counts: { open: 0, overdue: 0, completed: 0, blocked: 0, awaitingVerification: 0 },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('WorkTaskRow', () => {
  it('shows source, status and the evidence that proves completed work', () => {
    renderWithProviders(
      <WorkTaskRow
        task={task({ status: 'completed', effectiveStatus: 'completed', completionEvidence: { type: 'source_event', detail: 'Reply recorded (outlook).', at: '2026-11-24T10:00:00Z' } })}
        isAssignee
        canVerify={false}
        onChanged={() => undefined}
      />,
    );
    expect(screen.getByText('Reply to Asha: Quote please')).toBeInTheDocument();
    expect(screen.getByText('Outlook')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText(/Recorded in the source: Reply recorded/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open source/i })).toHaveAttribute('href', '/ai-email-inbox');
  });

  it('starts a task with one click, but asks for a note before requesting verification', async () => {
    vi.mocked(api.act).mockResolvedValue(task({ status: 'in_progress' }));
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<WorkTaskRow task={task()} isAssignee canVerify={false} onChanged={onChanged} />);

    await user.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.act).toHaveBeenCalledWith('t1', 'start', undefined));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: 'Request verification' }));
    const confirm = await screen.findAllByRole('button', { name: 'Request verification' });
    const submit = confirm[confirm.length - 1];
    expect(submit).toBeDisabled(); // no note yet
    await user.type(screen.getByLabelText('Note'), 'Sent the quote by email');
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(api.act).toHaveBeenCalledWith('t1', 'request_verification', 'Sent the quote by email'));
  });

  it('never offers a way to complete work to its own assignee', () => {
    renderWithProviders(<WorkTaskRow task={task({ status: 'awaiting_verification', effectiveStatus: 'awaiting_verification' })} isAssignee canVerify={false} onChanged={() => undefined} />);
    expect(screen.queryByRole('button', { name: /verify done/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers a manager verify / send back for work awaiting verification', () => {
    renderWithProviders(<WorkTaskRow task={task({ assignedTo: 'u9', status: 'awaiting_verification', effectiveStatus: 'awaiting_verification' })} isAssignee={false} canVerify onChanged={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Verify done' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send back' })).toBeInTheDocument();
  });
});

describe('MyWorkPage', () => {
  it('collects on open and lists overdue work before the rest, with counts', async () => {
    vi.mocked(api.myDay).mockResolvedValue(
      day({
        overdue: [task({ id: 'o1', title: 'Collect payment: quote #88', effectiveStatus: 'overdue', priority: 'high', dueDate: '2026-11-20T00:00:00Z' })],
        open: [task({ id: 'p1', title: 'Reply to Asha: Quote please' })],
        counts: { open: 2, overdue: 1, completed: 0, blocked: 0, awaitingVerification: 0 },
      }),
    );
    renderWithProviders(<MyWorkPage />);
    await waitFor(() => expect(api.syncMe).toHaveBeenCalledTimes(1));
    const overdue = await screen.findByRole('region', { name: 'Overdue' });
    expect(within(overdue).getByText('Collect payment: quote #88')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'To do' })).getByText('Reply to Asha: Quote please')).toBeInTheDocument();
  });

  it('says plainly when nothing is assigned', async () => {
    vi.mocked(api.myDay).mockResolvedValue(day());
    renderWithProviders(<MyWorkPage />);
    expect(await screen.findByText('Nothing assigned to you right now')).toBeInTheDocument();
  });
});

describe('TeamWorkPage', () => {
  const team: TeamDashboard = {
    date: '2026-11-24',
    timezone: 'Asia/Kolkata',
    eodTime: '18:00',
    admin: false,
    totals: { people: 2, open: 5, overdue: 1, completedToday: 3, reportsGenerated: 1, reportsMissing: 1 },
    rows: [
      { userId: 'a', name: 'Asha', email: 'asha@x.io', counts: { open: 3, overdue: 1, completedToday: 2, blocked: 0, awaitingVerification: 1 }, report: { state: 'generated', reportId: 'r1', deliveries: { employee: 'sent', manager: 'sent' } } },
      { userId: 'b', name: 'Ravi', email: 'ravi@x.io', counts: { open: 2, overdue: 0, completedToday: 1, blocked: 0, awaitingVerification: 0 }, report: { state: 'missing', deliveries: {} } },
    ],
  };

  it('shows each person with their report state, flagging missing ones', async () => {
    vi.mocked(api.team).mockResolvedValue(team);
    renderWithProviders(<TeamWorkPage />);
    const rows = await screen.findAllByTestId('team-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Generated')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Manager copy: sent/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('Missing')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('View')).not.toBeInTheDocument();
  });

  it('opens a person to review and verify their tasks', async () => {
    vi.mocked(api.team).mockResolvedValue(team);
    vi.mocked(api.userDay).mockResolvedValue(day({ userId: 'a', open: [task({ id: 'v1', assignedTo: 'a', status: 'awaiting_verification', effectiveStatus: 'awaiting_verification', title: 'Send revised quote' })] }));
    const user = userEvent.setup();
    renderWithProviders(<TeamWorkPage />);
    await user.click((await screen.findAllByTestId('team-row'))[0]);
    expect(await screen.findByText('Send revised quote')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify done' })).toBeInTheDocument();
    expect(api.userDay).toHaveBeenCalledWith('a');
  });

  it('explains how to get a team when no one reports to the viewer', async () => {
    vi.mocked(api.team).mockResolvedValue({ ...team, rows: [], totals: { ...team.totals, people: 0 } });
    renderWithProviders(<TeamWorkPage />);
    expect(await screen.findByText('No one reports to you yet')).toBeInTheDocument();
  });
});

describe('EodReportView zero-activity reading', () => {
  const base = { id: 'r1', userId: 'u1', employeeName: 'Idle', date: '2026-11-24', timezone: 'Asia/Kolkata', status: 'generated' as const, wasMissed: false, dataGaps: [], summary: 'x', summarySource: 'deterministic' as const };
  const sections = (headline: string, extra = {}) => ({
    completed: [], pending: [], overdue: [], blocked: [], awaitingVerification: [],
    meetings: { source: 'outlook_calendar', items: [] }, customerFollowUps: { repliesSent: 0, completed: [], pending: [] }, crmUpdates: [], nextDayPriorities: [],
    counts: { completed: 0, pending: 0, overdue: 0, blocked: 0, awaitingVerification: 0 },
    assessment: { headline, assignedWork: false, completedWork: false, activityDetected: false, activitySignals: 'complete', syncHealth: 'ok', syncNotes: [], ...extra },
  });

  it.each([
    ['no_assigned_work', {}, /No work is assigned to this person/],
    ['sync_unreliable', { syncHealth: 'degraded' }, /cannot show what was assigned or done/],
  ])('says %s plainly', async (headline, extra, text) => {
    vi.mocked(api.report).mockResolvedValue({ ...base, sections: sections(headline, extra) } as never);
    renderWithProviders(<EodReportView reportId="r1" />);
    expect(await screen.findByTestId('assessment')).toHaveTextContent(text);
    expect(screen.getByTestId('assessment')).not.toHaveTextContent(/unproductive|idle|underperform/i);
  });

  it('shows no banner when verified work was done', async () => {
    vi.mocked(api.report).mockResolvedValue({ ...base, sections: sections('worked', { completedWork: true }) } as never);
    renderWithProviders(<EodReportView reportId="r1" />);
    await screen.findByText('Idle');
    expect(screen.queryByTestId('assessment')).not.toBeInTheDocument();
  });
});
