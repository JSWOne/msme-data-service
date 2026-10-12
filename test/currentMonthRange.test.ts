import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentMonthRange } from '../src/routes/tables';

afterEach(() => {
  vi.useRealTimers();
});

describe('currentMonthRange', () => {
  it.each([
    ['mid-month', new Date(2026, 9, 12, 13, 45), '2026-10-01', '2026-11-01'],
    ['first day at midnight', new Date(2026, 9, 1, 0, 0, 0), '2026-10-01', '2026-11-01'],
    [
      'last moment of the month',
      new Date(2026, 9, 31, 23, 59, 59, 999),
      '2026-10-01',
      '2026-11-01',
    ],
    ['December rolls into January', new Date(2026, 11, 31, 23, 0), '2026-12-01', '2027-01-01'],
    ['January', new Date(2027, 0, 15), '2027-01-01', '2027-02-01'],
    ['February in a leap year', new Date(2028, 1, 29), '2028-02-01', '2028-03-01'],
    ['February in a common year', new Date(2027, 1, 28), '2027-02-01', '2027-03-01'],
    ['a 30-day month', new Date(2026, 10, 30), '2026-11-01', '2026-12-01'],
    ['single-digit month', new Date(2026, 2, 9), '2026-03-01', '2026-04-01'],
  ])('%s', (_label, now, startOfMonth, startOfNextMonth) => {
    expect(currentMonthRange(now)).toEqual({ startOfMonth, startOfNextMonth });
  });

  it('does not mutate the date it is given', () => {
    const now = new Date(2026, 11, 31, 23, 0);
    const before = now.getTime();
    currentMonthRange(now);
    expect(now.getTime()).toBe(before);
  });

  it('defaults to the current system time', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 4, 20, 10, 0));
    expect(currentMonthRange()).toEqual({
      startOfMonth: '2026-05-01',
      startOfNextMonth: '2026-06-01',
    });
  });

  it('returns YYYY-MM-DD strings', () => {
    const { startOfMonth, startOfNextMonth } = currentMonthRange(new Date(2026, 0, 5));
    expect(startOfMonth).toMatch(/^\d{4}-\d{2}-01$/);
    expect(startOfNextMonth).toMatch(/^\d{4}-\d{2}-01$/);
  });
});
