import { nextWindowOpening, windowNight, windowOpensLabel, windowSchedule, type SyncWindow } from './sync-window';

// Hoops: once a night, after 7:00pm AEST (UTC+10, no daylight saving) — 09:00 to 19:00 UTC.
const HOOPS: SyncWindow = { utcOffsetMinutes: 600, start: '19:00', end: '05:00', label: 'AEST' };
const at = (iso: string) => new Date(iso);

describe('nightly sync window (mirrors crm_mongo_sync.py)', () => {
  it('knows which night a moment falls in, across midnight', () => {
    expect(windowNight(HOOPS, at('2026-10-21T08:59:00Z'))).toBeNull();
    expect(windowNight(HOOPS, at('2026-10-21T09:00:00Z'))).toBe('2026-10-21');
    // 4:59am AEST on the 22nd still belongs to the night of the 21st.
    expect(windowNight(HOOPS, at('2026-10-21T18:59:00Z'))).toBe('2026-10-21');
    expect(windowNight(HOOPS, at('2026-10-21T19:00:00Z'))).toBeNull();
    // A same-day window.
    expect(windowNight({ ...HOOPS, start: '01:00', end: '03:00' }, at('2026-10-21T16:30:00Z'))).toBe('2026-10-22');
  });

  it('says when the next window opens', () => {
    expect(nextWindowOpening(HOOPS, at('2026-10-21T08:59:00Z')).toISOString()).toBe('2026-10-21T09:00:00.000Z');
    expect(nextWindowOpening(HOOPS, at('2026-10-21T10:00:00Z')).toISOString()).toBe('2026-10-22T09:00:00.000Z');
    expect(nextWindowOpening(HOOPS, at('2026-10-21T21:00:00Z')).toISOString()).toBe('2026-10-22T09:00:00.000Z');
    expect(windowOpensLabel(HOOPS)).toBe('7:00pm AEST');
  });

  it('allows "Sync now" once a night, inside the window only', () => {
    const before = windowSchedule(HOOPS, 'Hoops CRM', undefined, at('2026-10-21T05:00:00Z'));
    expect(before).toMatchObject({ canSyncNow: false, nextRunAt: at('2026-10-21T09:00:00Z') });
    expect(before.reason).toBe('Hoops CRM allows HaiVE to read once a night, after 7:00pm AEST. The next sync runs then by itself.');

    expect(windowSchedule(HOOPS, 'Hoops CRM', at('2026-10-20T09:30:00Z'), at('2026-10-21T09:10:00Z')).canSyncNow).toBe(true);

    const synced = windowSchedule(HOOPS, 'Hoops CRM', at('2026-10-21T09:05:00Z'), at('2026-10-21T12:00:00Z'));
    expect(synced).toMatchObject({ canSyncNow: false, nextRunAt: at('2026-10-22T09:00:00Z') });
    expect(synced.reason).toContain('Already synced tonight');
  });
});
