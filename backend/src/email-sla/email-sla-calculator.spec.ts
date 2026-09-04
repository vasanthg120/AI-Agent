import { BusinessHoursPolicy, EmailSlaCalculatorService } from './email-sla-calculator.service';

// Pure unit tests, no DB/network — Asia/Kolkata has no DST (a fixed UTC+5:30
// offset year-round), deliberately chosen so these tests never depend on
// the DST-transition edge case this calculator's own header comment flags
// as unhandled.
const POLICY: BusinessHoursPolicy = {
  timezone: 'Asia/Kolkata',
  workingDays: [1, 2, 3, 4, 5], // Mon-Fri
  workingStartTime: '09:00',
  workingEndTime: '18:00',
  holidays: [],
};

// IST is UTC+5:30 — helper to build a UTC Date from an IST wall-clock time
// so test inputs/expectations are easy to read as "what a user in that
// timezone would see", not raw UTC arithmetic.
function ist(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h - 5, mi - 30));
}

describe('EmailSlaCalculatorService', () => {
  const calculator = new EmailSlaCalculatorService();

  it('24/7 SLA (businessHoursEnabled:false) is plain calendar-time addition', () => {
    const received = ist(2026, 3, 6, 17, 0); // Friday 5:00 PM IST
    const due = calculator.calculateDueAt(received, 120, POLICY, false);
    expect(due.getTime()).toBe(received.getTime() + 120 * 60_000);
  });

  it('fits entirely within the same working day', () => {
    const received = ist(2026, 3, 2, 10, 0); // Monday 10:00 AM IST
    const due = calculator.calculateDueAt(received, 120, POLICY, true); // 2 business hours
    expect(due).toEqual(ist(2026, 3, 2, 12, 0)); // Monday 12:00 PM
  });

  it('rolls over a weekend when the window runs out — Friday 5pm + 2 business hours', () => {
    // Friday 17:00 leaves exactly 60 minutes before 18:00 close; the
    // remaining 60 minutes land at Monday 09:00 + 60min = Monday 10:00.
    const received = ist(2026, 3, 6, 17, 0); // Friday
    const due = calculator.calculateDueAt(received, 120, POLICY, true);
    expect(due).toEqual(ist(2026, 3, 9, 10, 0)); // Monday
  });

  it('an email received before opening starts its clock at opening the same day', () => {
    const received = ist(2026, 3, 2, 7, 0); // Monday 7:00 AM, before 9:00 open
    const due = calculator.calculateDueAt(received, 60, POLICY, true);
    expect(due).toEqual(ist(2026, 3, 2, 10, 0)); // Monday 09:00 + 60min
  });

  it('an email received after closing rolls to the next working day', () => {
    const received = ist(2026, 3, 2, 19, 0); // Monday 7:00 PM, after 18:00 close
    const due = calculator.calculateDueAt(received, 60, POLICY, true);
    expect(due).toEqual(ist(2026, 3, 3, 10, 0)); // Tuesday 09:00 + 60min
  });

  it('an email received on a weekend rolls to the next Monday', () => {
    const received = ist(2026, 3, 7, 12, 0); // Saturday
    const due = calculator.calculateDueAt(received, 30, POLICY, true);
    expect(due).toEqual(ist(2026, 3, 9, 9, 30)); // Monday 09:00 + 30min
  });

  it('skips a configured holiday', () => {
    // Monday 2026-03-09 marked a holiday — Friday 17:00 + 2h should now
    // skip straight to Tuesday (the next real working day) instead of Monday.
    const policyWithHoliday: BusinessHoursPolicy = { ...POLICY, holidays: ['2026-03-09'] };
    const received = ist(2026, 3, 6, 17, 0); // Friday
    const due = calculator.calculateDueAt(received, 120, policyWithHoliday, true);
    expect(due).toEqual(ist(2026, 3, 10, 10, 0)); // Tuesday 09:00 + 60min
  });

  it('needing exactly the rest of today lands at closing time today, not tomorrow', () => {
    // The daily window is 9h (09:00-18:00) — 9 hours needed starting exactly
    // at opening consumes the whole day and lands precisely at closing.
    const received = ist(2026, 3, 2, 9, 0); // Monday, exactly at opening
    const due = calculator.calculateDueAt(received, 9 * 60, POLICY, true);
    expect(due).toEqual(ist(2026, 3, 2, 18, 0)); // Monday 18:00 (closing)
  });

  it('an SLA longer than one working day spans multiple days correctly', () => {
    // 10 working hours needed exceeds the 9h/day window starting Monday
    // 09:00 -> all of Monday (9h) is consumed, the remaining 1h lands at
    // Tuesday 09:00 + 60min.
    const received = ist(2026, 3, 2, 9, 0); // Monday, exactly at opening
    const due = calculator.calculateDueAt(received, 10 * 60, POLICY, true);
    expect(due).toEqual(ist(2026, 3, 3, 10, 0)); // Tuesday 10:00
  });
});
