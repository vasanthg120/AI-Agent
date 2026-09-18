import { todayStamp } from './store-settings.service';

// Pure-function unit test (no Mongo needed) for the timezone fix — todayStamp
// previously used plain server UTC, inconsistent with nowMinutesInZone's own
// store-timezone-aware trigger check in the same file. Verifies the exact
// regression: a store timezone far enough from UTC gets its own correct
// calendar date, not the server's.
describe('todayStamp (store-settings.service.ts)', () => {
  it('returns the correct YYYY-MM-DD for a given IANA timezone', () => {
    // A fixed instant near a UTC day boundary, deliberately chosen so a
    // >12-hour-offset timezone's calendar date differs from UTC's.
    const fixedInstant = new Date('2026-01-15T23:30:00.000Z');
    jest.useFakeTimers().setSystemTime(fixedInstant);
    try {
      // UTC itself: same date as the instant.
      expect(todayStamp('UTC')).toBe('2026-01-15');
      // Pacific/Kiritimati is UTC+14 — 23:30 UTC on the 15th is already
      // 13:30 on the 16th there.
      expect(todayStamp('Pacific/Kiritimati')).toBe('2026-01-16');
      // Etc/GMT+12 (note: POSIX-inverted sign) is UTC-12 — 23:30 UTC on the
      // 15th is still 11:30 on the 15th there.
      expect(todayStamp('Etc/GMT+12')).toBe('2026-01-15');
    } finally {
      jest.useRealTimers();
    }
  });

  it('matches nowMinutesInZone-style store-local wall-clock date, not server UTC, for a real store timezone', () => {
    const fixedInstant = new Date('2026-06-01T19:00:00.000Z'); // 19:00 UTC
    jest.useFakeTimers().setSystemTime(fixedInstant);
    try {
      // Asia/Kolkata is UTC+5:30 — 19:00 UTC on June 1 is 00:30 on June 2 there.
      expect(todayStamp('Asia/Kolkata')).toBe('2026-06-02');
      expect(todayStamp('UTC')).toBe('2026-06-01');
    } finally {
      jest.useRealTimers();
    }
  });
});
