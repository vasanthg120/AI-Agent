import { businessDayOf, businessDayRange, startOfBusinessDay, validTimeZone } from './business-day';

describe('business day', () => {
  it('a day in India starts at 18:30 UTC the evening before', () => {
    expect(startOfBusinessDay('Asia/Kolkata', '2026-11-11').toISOString()).toBe('2026-11-10T18:30:00.000Z');
    // The old alias Surryhills' setting carried still works.
    expect(startOfBusinessDay('Asia/Calcutta', '2026-11-11').toISOString()).toBe('2026-11-10T18:30:00.000Z');
  });

  it('Sydney follows daylight saving: +11 in November, +10 in July', () => {
    expect(startOfBusinessDay('Australia/Sydney', '2026-11-11').toISOString()).toBe('2026-11-10T13:00:00.000Z');
    expect(startOfBusinessDay('Australia/Sydney', '2026-07-01').toISOString()).toBe('2026-06-30T14:00:00.000Z');
    // The day daylight saving starts (4 Oct 2026, clocks go forward at 2am): midnight is still +10.
    expect(startOfBusinessDay('Australia/Sydney', '2026-10-04').toISOString()).toBe('2026-10-03T14:00:00.000Z');
    expect(startOfBusinessDay('Australia/Sydney', '2026-10-05').toISOString()).toBe('2026-10-04T13:00:00.000Z');
  });

  it('a range covers whole days, both ends included, end exclusive', () => {
    expect(businessDayRange('Asia/Kolkata', '2026-11-01', '2026-11-10')).toEqual({
      start: new Date('2026-10-31T18:30:00.000Z'),
      end: new Date('2026-11-10T18:30:00.000Z'),
    });
    // An end before the start is the start day alone.
    const one = businessDayRange('Asia/Kolkata', '2026-11-10', '2026-11-01');
    expect(one.end.getTime() - one.start.getTime()).toBe(86_400_000);
  });

  it('which day an instant falls on depends on the business', () => {
    const instant = new Date('2026-11-10T20:00:00.000Z');
    expect(businessDayOf('Asia/Kolkata', instant)).toBe('2026-11-11');
    expect(businessDayOf('Australia/Sydney', instant)).toBe('2026-11-11');
    expect(businessDayOf('UTC', instant)).toBe('2026-11-10');
  });

  it('an unknown or missing zone falls back to India rather than failing', () => {
    expect(validTimeZone('Mars/Olympus')).toBe('Asia/Kolkata');
    expect(validTimeZone(undefined)).toBe('Asia/Kolkata');
    expect(validTimeZone('Australia/Sydney')).toBe('Australia/Sydney');
  });
});
