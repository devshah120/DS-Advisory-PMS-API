import { minimumConfidenceFor } from './corporate-action.scheduler';

/**
 * The per-type booking threshold (user decision, 2026-11-18): plain dividends
 * book at 75 so Yahoo-only reports go through; everything that changes share
 * counts or cost basis keeps the general bar.
 */
describe('minimumConfidenceFor', () => {
  it('lets a Yahoo-only (75) dividend or special dividend through under the default 90', () => {
    expect(minimumConfidenceFor('DIVIDEND', 90)).toBe(75);
    expect(minimumConfidenceFor('SPECIAL_DIVIDEND', 90)).toBe(75);
  });

  it.each([
    'STOCK_SPLIT',
    'REVERSE_SPLIT',
    'BONUS_ISSUE',
    'STOCK_DIVIDEND',
    'RIGHTS_ISSUE',
    'SPIN_OFF',
    'RETURN_OF_CAPITAL',
    'CASH_DISTRIBUTION',
  ])('keeps %s at the general bar', (type) => {
    expect(minimumConfidenceFor(type, 90)).toBe(90);
  });

  it('never holds dividends to a stricter bar than the general one', () => {
    expect(minimumConfidenceFor('DIVIDEND', 60)).toBe(60);
    expect(minimumConfidenceFor('STOCK_SPLIT', 60)).toBe(60);
  });
});
