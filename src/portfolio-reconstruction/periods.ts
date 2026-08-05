import { BadRequestException } from '@nestjs/common';
import { INCEPTION_DATE } from '../analytics/calculators/flows';

/**
 * The period vocabulary behind the Performance sheet's period selector.
 *
 * One rule governs every entry here: **no window may open before
 * 30-June-2026**. That date is the house inception — the imported book's
 * opening value — and it is the only date before which we have no priceable
 * history. A window that opened earlier would divide by an opening value we
 * cannot substantiate, which is exactly the class of bug that produced
 * nonsense returns on this book before.
 *
 * So `INCEPTION` opens there by definition, and every calendar window is
 * clamped to it. In practice that also makes the identity the desk expects
 * fall out for free: today (Q3 CY26) the quarter opened 1-July, the day after
 * inception with no trading in between, so QTD and INCEPTION resolve to the
 * same opening value and report the same number.
 */

/** A named quarter, e.g. `Q3-CY26`. */
const QUARTER_CODE = /^Q([1-4])-CY(\d{2})$/;

export type PeriodCode = 'INCEPTION' | 'MTD' | 'QTD' | 'YTD' | 'CUSTOM' | string;

export interface ResolvedPeriod {
  /** The code as requested — echoed back so the UI can label the figure. */
  period: PeriodCode;
  /** Human label for the sheet, e.g. "Q3 CY26" or "Since inception". */
  label: string;
  from: Date;
  to: Date;
  /**
   * True when `from` was pulled forward to inception. The sheet says so, because
   * a "Q2 CY26" figure that actually measures one day is a number a reader would
   * otherwise misread as a full quarter.
   */
  clampedToInception: boolean;
  /** True when `to` was pulled back to today because the quarter has not closed. */
  openPeriod: boolean;
}

function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Does a window starting at `rawFrom` open on the trading day immediately after
 * inception, with no valuation of its own in between?
 *
 * Inception is 30-June, a quarter-end and a month-end, so the very next period —
 * Q3 CY26, July MTD, and QTD while we are still in Q3 — nominally starts 1-July.
 * There is no separate 1-July opening value: it IS the 30-June close. Anchoring
 * such a window on inception keeps its return measured from a real priced base
 * rather than from a date we would have to invent a value for.
 *
 * Deliberately narrow — one day. A window starting 1-August is a genuine
 * later window and must keep its own opening value.
 */
function isFirstPeriodAfterInception(rawFrom: Date, inception: Date): boolean {
  const dayAfter = new Date(inception.getTime() + 86_400_000);
  return utcDay(rawFrom).getTime() === utcDay(dayAfter).getTime();
}

/** Quarter q (1-4) of a 20xx year → [start, end] in UTC, end = last day of the quarter. */
function quarterRange(q: number, year: number): { start: Date; end: Date } {
  const startMonth = (q - 1) * 3;
  return {
    start: new Date(Date.UTC(year, startMonth, 1)),
    // Day 0 of the month AFTER the quarter is the quarter's last day.
    end: new Date(Date.UTC(year, startMonth + 3, 0)),
  };
}

/**
 * The list the dropdown renders: inception, the rolling windows, then every
 * quarter from the one containing inception up to the one containing `asOf`,
 * newest first. Generated rather than hard-coded so the sheet keeps working
 * into CY27 without a redeploy.
 */
export function availablePeriods(asOf: Date = new Date()): Array<{ code: string; label: string }> {
  const periods: Array<{ code: string; label: string }> = [
    { code: 'INCEPTION', label: 'Since inception (30 Jun 2026)' },
    { code: 'QTD', label: 'Quarter to date' },
    { code: 'MTD', label: 'Month to date' },
    { code: 'YTD', label: 'Year to date' },
  ];

  const quarters: Array<{ code: string; label: string }> = [];
  const startYear = INCEPTION_DATE.getUTCFullYear();
  const endYear = asOf.getUTCFullYear();
  const endQ = Math.floor(asOf.getUTCMonth() / 3) + 1;

  /**
   * Start from the quarter AFTER the one containing inception.
   *
   * Inception (30 June) is the last day of Q2 CY26, so "Q2 CY26" would resolve to
   * a window that opens and closes on the same date — a guaranteed 0.00% that
   * looks like a real quarterly result. The quarter inception closes is not a
   * measurable period; the first measurable one is the quarter it opens.
   */
  const inceptionQ = Math.floor(INCEPTION_DATE.getUTCMonth() / 3) + 1;
  const startQ = inceptionQ === 4 ? 1 : inceptionQ + 1;
  const firstYear = inceptionQ === 4 ? startYear + 1 : startYear;

  for (let y = firstYear; y <= endYear; y++) {
    const first = y === firstYear ? startQ : 1;
    const last = y === endYear ? endQ : 4;
    for (let q = first; q <= last; q++) {
      const cy = String(y).slice(-2);
      quarters.push({ code: `Q${q}-CY${cy}`, label: `Q${q} CY${cy}` });
    }
  }

  // Newest quarter first — the one a user wants is almost always the recent one.
  return [...periods, ...quarters.reverse(), { code: 'CUSTOM', label: 'Custom range…' }];
}

/**
 * Resolve a period code (plus optional custom dates) into a concrete window.
 *
 * `to` is clamped to `asOf` for any period that has not closed yet, so selecting
 * the current quarter measures through today rather than projecting to a future
 * quarter-end we have no prices for.
 */
export function resolvePeriod(
  code: PeriodCode,
  opts: { asOf?: Date; from?: Date; to?: Date } = {},
): ResolvedPeriod {
  const asOf = utcDay(opts.asOf ?? new Date());
  const inception = utcDay(INCEPTION_DATE);

  const clamp = (
    rawFrom: Date,
    rawTo: Date,
    period: PeriodCode,
    label: string,
  ): ResolvedPeriod => {
    /**
     * A window opens at the LAST VALUATION ON OR BEFORE its nominal start, and
     * for the first quarter that means inception itself.
     *
     * The nominal start of Q3 is 1-July, but no valuation exists for 1-July that
     * isn't just 30-June carried forward — the book did not trade in between, and
     * 30-June is the only priced opening value we have. Anchoring on 30-June is
     * therefore both more correct (it is the real opening value of the quarter)
     * and gives the identity the desk expects: with no flows between the two
     * dates, QTD and INCEPTION report the same number, because they are measuring
     * the same thing.
     *
     * `inceptionAnchored` is the flag for "this window was pulled back to the
     * 30-June base", covering both the pull-BACK here and the pull-FORWARD of a
     * window that tried to start before inception.
     */
    const startsBeforeInception = rawFrom < inception;
    const anchorsOnInception = isFirstPeriodAfterInception(rawFrom, inception);

    const clampedToInception = startsBeforeInception || anchorsOnInception;
    const from = clampedToInception ? inception : utcDay(rawFrom);

    const openPeriod = rawTo > asOf;
    const to = openPeriod ? asOf : utcDay(rawTo);

    if (to < from) {
      throw new BadRequestException(
        `Period "${label}" ends ${to.toISOString().slice(0, 10)}, before it starts ` +
          `${from.toISOString().slice(0, 10)}. Nothing can be measured over it — the house has ` +
          `no history before ${inception.toISOString().slice(0, 10)}.`,
      );
    }

    return { period, label, from, to, clampedToInception, openPeriod };
  };

  if (code === 'INCEPTION') {
    return clamp(inception, asOf, 'INCEPTION', 'Since inception');
  }

  if (code === 'MTD') {
    const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
    return clamp(from, asOf, 'MTD', 'Month to date');
  }

  if (code === 'QTD') {
    const q = Math.floor(asOf.getUTCMonth() / 3);
    const from = new Date(Date.UTC(asOf.getUTCFullYear(), q * 3, 1));
    return clamp(from, asOf, 'QTD', 'Quarter to date');
  }

  if (code === 'YTD') {
    const from = new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
    return clamp(from, asOf, 'YTD', 'Year to date');
  }

  if (code === 'CUSTOM') {
    if (!opts.from) {
      throw new BadRequestException('A custom period needs ?from=YYYY-MM-DD.');
    }
    return clamp(opts.from, opts.to ?? asOf, 'CUSTOM', 'Custom range');
  }

  const match = QUARTER_CODE.exec(code);
  if (match) {
    const q = Number(match[1]);
    const year = 2000 + Number(match[2]);
    const { start, end } = quarterRange(q, year);
    return clamp(start, end, code, `Q${q} CY${match[2]}`);
  }

  throw new BadRequestException(
    `Unknown period "${code}". Expected INCEPTION, MTD, QTD, YTD, CUSTOM, or a quarter like Q3-CY26.`,
  );
}
