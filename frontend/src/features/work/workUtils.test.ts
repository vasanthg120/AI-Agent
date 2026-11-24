import { describe, expect, it } from 'vitest';
import type { HierarchyPerson } from '@/services/workAutomationService';
import { availableActions, dueLabel, evidenceLabel, managerCandidates, platformLabel, skipReasonLabel } from './workUtils';
import { shouldSyncFor } from './useWorkSyncOnOpen';

const names = (a: { action: string }[]) => a.map((x) => x.action);

describe('availableActions', () => {
  it('lets the assignee start, block and request verification — never complete', () => {
    expect(names(availableActions({ status: 'pending' }, { isAssignee: true, canVerify: false }))).toEqual(['start', 'block', 'request_verification']);
    expect(names(availableActions({ status: 'in_progress' }, { isAssignee: true, canVerify: false }))).toEqual(['block', 'request_verification']);
    expect(names(availableActions({ status: 'blocked' }, { isAssignee: true, canVerify: false }))).toEqual(['start', 'unblock', 'request_verification']);
    for (const status of ['pending', 'in_progress', 'blocked', 'awaiting_verification', 'completed'] as const) {
      expect(names(availableActions({ status }, { isAssignee: true, canVerify: false }))).not.toContain('verify');
    }
  });

  it('gives a verifier verify / send back only for work awaiting verification, and reopen for completed work', () => {
    expect(names(availableActions({ status: 'awaiting_verification' }, { isAssignee: false, canVerify: true }))).toEqual(['verify', 'reject_verification']);
    expect(names(availableActions({ status: 'completed' }, { isAssignee: false, canVerify: true }))).toEqual(['reopen']);
    expect(availableActions({ status: 'pending' }, { isAssignee: false, canVerify: true })).toEqual([]);
  });

  it('shows nothing to someone with no relationship to the task', () => {
    expect(availableActions({ status: 'awaiting_verification' }, { isAssignee: false, canVerify: false })).toEqual([]);
  });

  it('requires a note for every action that changes meaning (block, verify, send back, reopen, request verification)', () => {
    const all = [
      ...availableActions({ status: 'pending' }, { isAssignee: true, canVerify: false }),
      ...availableActions({ status: 'awaiting_verification' }, { isAssignee: false, canVerify: true }),
    ];
    expect(all.filter((a) => a.action !== 'start').every((a) => a.needsNote)).toBe(true);
    expect(all.find((a) => a.action === 'start')?.needsNote).toBe(false);
  });
});

describe('managerCandidates', () => {
  const people: HierarchyPerson[] = [
    { id: 'boss', name: 'Boss', email: 'b@x.io', active: true },
    { id: 'lead', name: 'Lead', email: 'l@x.io', active: true, reportingManagerId: 'boss' },
    { id: 'emp', name: 'Emp', email: 'e@x.io', active: true, reportingManagerId: 'lead' },
    { id: 'gone', name: 'Gone', email: 'g@x.io', active: false },
    { id: 'other', name: 'Other', email: 'o@x.io', active: true },
  ];
  it('excludes the person, everyone below them, and inactive people', () => {
    expect(managerCandidates(people, 'boss').map((p) => p.id)).toEqual(['other']);
    expect(managerCandidates(people, 'emp').map((p) => p.id)).toEqual(['boss', 'lead', 'other']);
    expect(managerCandidates(people, 'lead').map((p) => p.id)).toEqual(['boss', 'other']);
  });
});

describe('labels', () => {
  it('labels deadlines in whole days', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(dueLabel(undefined, now)).toBe('');
    expect(dueLabel('2026-11-21T12:00:00Z', now)).toBe('Overdue by 3 days');
    expect(dueLabel('2026-11-23T11:00:00Z', now)).toBe('Overdue by 1 day');
    expect(dueLabel('2026-11-24T20:00:00Z', now)).toMatch(/^Due /);
  });
  it('names platforms, evidence and skipped deliveries in plain words', () => {
    expect(platformLabel('hoops')).toBe('Hoops');
    expect(platformLabel('zoho')).toBe('Zoho');
    expect(evidenceLabel('manual_verified')).toBe('Verified by a person');
    expect(skipReasonLabel('no_manager_configured')).toMatch(/No reporting manager/);
    expect(skipReasonLabel('some_new_reason')).toBe('some new reason');
  });
});

describe('shouldSyncFor', () => {
  it('asks for a sync once per person per tab, and never without a user', () => {
    const seen = new Set<string>();
    expect(shouldSyncFor(undefined, seen)).toBe(false);
    expect(shouldSyncFor('u1', seen)).toBe(true);
    expect(shouldSyncFor('u1', seen)).toBe(false);
    expect(shouldSyncFor('u2', seen)).toBe(true);
  });
});
