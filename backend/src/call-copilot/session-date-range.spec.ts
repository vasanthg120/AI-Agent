import { sessionRangeEnd, sessionRangeStart } from './session-date-range';

describe('Call Library date range', () => {
  it('reads a bare date as the start of that day for the lower bound', () => {
    expect(sessionRangeStart('2026-09-25').toISOString()).toBe('2026-09-25T00:00:00.000Z');
  });

  it('reads a bare date as the END of that day for the upper bound', () => {
    expect(sessionRangeEnd('2026-09-25').toISOString()).toBe('2026-09-25T23:59:59.999Z');
  });

  it('so a same-day range (Today) actually contains that day', () => {
    const from = sessionRangeStart('2026-09-25');
    const to = sessionRangeEnd('2026-09-25');
    const lunchtime = new Date('2026-09-25T09:10:00.000Z');
    expect(lunchtime >= from && lunchtime <= to).toBe(true);
    // ...and nothing from the neighbouring days.
    expect(new Date('2026-09-24T23:59:59.999Z') >= from).toBe(false);
    expect(new Date('2026-09-26T00:00:00.000Z') <= to).toBe(false);
  });

  it('takes a full timestamp exactly as given (the web app sends the viewer\'s local day boundaries)', () => {
    const endOfLocalDay = '2026-09-25T18:29:59.999Z'; // 23:59:59.999 in India
    expect(sessionRangeEnd(endOfLocalDay).toISOString()).toBe(endOfLocalDay);
    expect(sessionRangeStart('2026-09-24T18:30:00.000Z').toISOString()).toBe('2026-09-24T18:30:00.000Z');
  });
});
