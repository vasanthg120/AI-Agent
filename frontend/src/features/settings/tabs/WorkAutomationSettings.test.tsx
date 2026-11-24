import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AutomationConfig } from '@/services/workAutomationService';
import { renderWithProviders } from '@/test/renderWithProviders';

vi.mock('@/services/workAutomationService', async (orig) => {
  const actual = await orig<typeof import('@/services/workAutomationService')>();
  return {
    ...actual,
    workAutomationService: {
      getConfig: vi.fn(),
      updateConfig: vi.fn(),
      syncStatus: vi.fn(),
      runSync: vi.fn(),
      runEod: vi.fn(),
      hierarchy: vi.fn(),
      setManager: vi.fn(async () => ({ ok: true })),
      identities: vi.fn(),
      linkIdentity: vi.fn(async () => ({ ok: true })),
      ignoreIdentity: vi.fn(async () => ({ ok: true })),
    },
  };
});
vi.mock('react-hot-toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/utils/timezones', () => ({ TIMEZONE_GROUPS: [['Asia', ['Asia/Kolkata']]], isKnownTimezone: () => true }));

import { workAutomationService as api } from '@/services/workAutomationService';
import { WorkAutomationSettings } from './WorkAutomationSettings';

const config: AutomationConfig = {
  enabled: true,
  eodTime: '18:00',
  timezone: '',
  enabledSources: ['crm', 'email'],
  crmProviders: ['prospectconnect', 'hoops'],
  staleDealDays: 7,
  dealCloseWindowDays: 7,
  quoteDueWindowDays: 3,
  emailLookbackDays: 7,
  syncOnLoginMinIntervalMin: 15,
  sendToManager: true,
  deliveryChannels: ['gmail', 'outlook', 'smtp'],
  maxDeliveryAttempts: 3,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getConfig).mockResolvedValue({
    config,
    effectiveTimezone: 'Asia/Kolkata',
    unsupported: [{ id: 'gorilladash', label: 'GorillaDash', reason: 'The API exposes no tasks or assignees.' }],
    sources: [
      { id: 'crm', label: 'CRM deals & quotes', description: 'Pantheras, Hoops', enabled: true },
      { id: 'email', label: 'Email follow-ups', description: 'Outlook', enabled: true },
    ],
  });
  vi.mocked(api.updateConfig).mockResolvedValue({ config, effectiveTimezone: 'Asia/Kolkata' });
  vi.mocked(api.syncStatus).mockResolvedValue({
    adapters: [
      { id: 'crm', label: 'CRM deals & quotes', enabled: true, last: { adapterId: 'crm', trigger: 'schedule', status: 'ok', startedAt: '2026-11-24T10:00:00Z', finishedAt: '2026-11-24T10:00:02Z', fetched: 4, created: 2, updated: 0, completed: 1, deactivated: 0, unresolved: 0 } },
      { id: 'email', label: 'Email follow-ups', enabled: true, last: { adapterId: 'email', trigger: 'schedule', status: 'failed', startedAt: '2026-11-24T10:00:00Z', finishedAt: '2026-11-24T10:00:01Z', fetched: 0, created: 0, updated: 0, completed: 0, deactivated: 0, unresolved: 0, error: 'Mailbox read timed out' } },
    ],
    unresolvedIdentities: 1,
    recent: [],
  });
  vi.mocked(api.hierarchy).mockResolvedValue([
    { id: 'boss', name: 'Boss', email: 'boss@x.io', active: true },
    { id: 'emp', name: 'Sanjay', email: 'sanjay@x.io', active: true, reportingManagerId: 'boss' },
    { id: 'gone', name: 'Gone', email: 'gone@x.io', active: false },
  ]);
  vi.mocked(api.identities).mockResolvedValue([{ id: 'i1', platform: 'hoops', externalUserId: 'H-8', externalName: 'Sanjay K', status: 'unresolved', seenCount: 3 }]);
});

describe('WorkAutomationSettings', () => {
  it('saves the EOD time the admin picks', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkAutomationSettings />);
    const time = await screen.findByLabelText('End-of-day time');
    await user.clear(time);
    await user.type(time, '19:30');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalled());
    expect(vi.mocked(api.updateConfig).mock.calls[0][0]).toMatchObject({ eodTime: '19:30', sendToManager: true, deliveryChannels: ['gmail', 'outlook', 'smtp'] });
  });

  it('states which sources cannot be collected from and why, instead of implying support', async () => {
    renderWithProviders(<WorkAutomationSettings />);
    expect(await screen.findByTestId('unsupported-source')).toHaveTextContent('GorillaDash. The API exposes no tasks or assignees.');
  });

  it('shows each integration’s last synchronization and its error', async () => {
    renderWithProviders(<WorkAutomationSettings />);
    expect(await screen.findByText('Mailbox read timed out')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('only offers valid managers, and sets and clears them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkAutomationSettings />);
    const boss = await screen.findByLabelText('Reporting manager of Boss');
    // The boss cannot report to their own report, and an inactive person is never offered.
    expect(within(boss).queryByRole('option', { name: 'Sanjay' })).not.toBeInTheDocument();
    expect(within(boss).queryByRole('option', { name: 'Gone' })).not.toBeInTheDocument();
    const emp = screen.getByLabelText('Reporting manager of Sanjay');
    expect(emp).toHaveValue('boss');
    await user.selectOptions(emp, '');
    await waitFor(() => expect(api.setManager).toHaveBeenCalledWith('emp', null));
    expect(screen.queryByLabelText('Reporting manager of Gone')).not.toBeInTheDocument();
  });

  it('keeps an unmatched platform user unassigned until the admin picks an employee', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkAutomationSettings />);
    const link = await screen.findByRole('button', { name: 'Link' });
    expect(link).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Employee for H-8'), 'emp');
    expect(link).toBeEnabled();
    await user.click(link);
    await waitFor(() => expect(api.linkIdentity).toHaveBeenCalledWith('i1', 'emp'));
  });
});
