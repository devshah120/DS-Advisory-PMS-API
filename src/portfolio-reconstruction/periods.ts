import { BadRequestException } from '@nestjs/common';
import { INCEPTION_DATE } from '../analytics/calculators/flows';
import {
  DEFAULT_MARKET,
  Market,
  MARKETS,
  fiscalQuarterCode,
  fiscalQuarterLabel,
  fiscalQuarterOf,
  fiscalQuarterRange,
  fiscalYearCode,
  fiscalYearLabel,
  fiscalYearOf,
  fiscalYearRange,
} from '../common/market-scope';

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
 * fall out for free: today the quarter opened 1-July, the day after inception
 * with no trading in between, so QTD and INCEPTION resolve to the same opening
 * value and report the same number.
 *
 * ── Two calendars ──────────────────────────────────────────────────────────
 * Every window here is resolved against the MARKET's reporting calendar, not
 * against the calendar year. The Indian book runs April–March, so on that book
 * `QTD` today means Q2 FY27 (Jul–Sep 2026) and `FYTD` opens on the 31-March
 * close; the US book keeps January–December and is unchanged. `CYTD` is offered
 * on both and always means 31-December → today, because an Indian desk still
 * reconciles some things (index performance, offshore statements) on the
 * calendar year even though it reports on the fiscal one.
 *
 * The market is a parameter rather than a global because both books are served
 * from one deployment — see market-scope.ts, which owns the month arithmetic
 * and the FY-naming convention (India names a year for the year it ENDS in, so
 * Apr-2026 → Mar-2027 is FY27).
 */

/**
 * A named quarter, e.g. `Q2-FY27` or `Q3-CY26`. The prefix carries the calendar,
 * so a code is unambiguous on its own and a stale bookmark cannot silently
 * resolve against the wrong one.
 */
const QUARTER_CODE = /^Q([1-4])-(FY|CY)(\d{2})$/;

/** A whole named year, e.g. `FY27` or `CY26`. */
const YEAR_CODE = /^(FY|CY)(\d{2})$/;

export type PeriodCode =
  | 'INCEPTION'
  | 'MTD'
  | 'QTD'
  | 'FYTD'
  | 'CYTD'
  | 'CUSTOM'
  | string;

export interface ResolvedPeriod {
  /** The code as requested — echoed back so the UI can label the figure. */
  period: PeriodCode;
  /** Human label for the sheet, e.g. "Q2 FY27" or "Since inception". */
  label: string;
  from: Date;
  to: Date;
  /**
   * True when `from` was pulled forward to inception. The sheet says so, because
   * a "Q1 FY27" figure that actually measures one day is a number a reader would
   * otherwise misread as a full quarter.
   */
  clampedToInception: boolean;
  /**
   * The date the window WOULD have opened on had the house priced history that
   * far back, when that differs from `from`.
   *
   * This is what lets the sheet say "FYTD, measured from 30-Jun-2026 rather than
   * 01-Apr-2026" instead of printing a bare "FYTD" over a number that is 90 days
   * short of one. A clamped figure is publishable; a clamped figure wearing an
   * unqualified label is not, and this field is what makes the difference
   * renderable rather than a comment nobody reads.
   */
  nominalFrom?: Date;
  /** Days lost to the clamp — `nominalFrom` → `from`. Zero when unclamped. */
  daysClamped: number;
  /** True when `to` was pulled back to today because the period has not closed. */
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

/**
 * Which market's calendar a `FY`/`CY` prefix refers to.
 *
 * A code carries its own calendar so it can be resolved without ambiguity, but
 * only one market actually uses each prefix, so the prefix identifies it. A US
 * client asking for `FY27` is asking for the Indian calendar explicitly and gets
 * it — the alternative (silently reinterpreting it as CY27) would answer a
 * different question than the one asked.
 */
function marketForPrefix(prefix: string, fallback: Market): Market {
  const match = (Object.keys(MARKETS) as Market[]).find(
    (m) => MARKETS[m].fiscalYear.labelPrefix === prefix,
  );
  return match ?? fallback;
}

/** One entry in the period dropdown. `group` drives the optgroup it renders in. */
export interface PeriodOption {
  code: string;
  label: string;
  /** The concrete window, so the UI can show dates without a round-trip. */
  hint: string;
  group: 'Current' | 'Quarters' | 'Years' | 'Custom';
}

/**
 * The list the dropdown renders, on the given market's calendar.
 *
 * Ordered the way the desk actually reads it: the live windows first (the
 * current quarter leads, because it is what a review meeting opens on), then
 * closed quarters newest-first, then whole closed years, then custom. Generated
 * rather than hard-coded so the sheet keeps working into FY28 without a
 * redeploy.
 */
export function availablePeriods(
  asOf: Date = new Date(),
  market: Market = DEFAULT_MARKET,
): PeriodOption[] {
  const day = utcDay(asOf);
  const inception = utcDay(INCEPTION_DATE);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  const fy = fiscalYearOf(day, market);
  const q = fiscalQuarterOf(day, market);
  const { startMonth } = MARKETS[market].fiscalYear;

  /**
   * The current quarter leads and names itself — "Q2 FY27" rather than a generic
   * "Quarter to date", because the desk thinks in the named quarter and a label
   * that hides which quarter it is forces a mental lookup on every read.
   */
  const current: PeriodOption[] = [
    {
      code: 'QTD',
      label: `${fiscalQuarterLabel(q, fy, market)} to date`,
      hint: `${fmt(fiscalQuarterRange(q, fy, market).start)} → today`,
      group: 'Current',
    },
    {
      code: 'FYTD',
      label: `${fiscalYearLabel(fy, market)} to date`,
      hint: `${fmt(fiscalYearRange(fy, market).start)} → today`,
      group: 'Current',
    },
    {
      code: 'CYTD',
      label: 'Calendar year to date',
      hint: `${fmt(new Date(Date.UTC(day.getUTCFullYear(), 0, 1)))} → today`,
      group: 'Current',
    },
    {
      code: 'MTD',
      label: 'Month to date',
      hint: `${fmt(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)))} → today`,
      group: 'Current',
    },
    {
      code: 'INCEPTION',
      label: 'Since inception',
      hint: `${fmt(inception)} → today`,
      group: 'Current',
    },
  ];

  /**
   * Closed quarters, walking back from the one before the current quarter to the
   * one containing inception.
   *
   * A quarter is only listed if it has measurable length once clamped. Inception
   * (30-June) is the last day of Q1 FY27 on the Indian calendar, so that quarter
   * would resolve to a zero-length window — a guaranteed 0.00% that reads like a
   * real quarterly result. `resolvePeriod` throws on it; rather than duplicate
   * that rule, we simply ask it and drop what it rejects, so the list and the
   * resolver cannot drift apart.
   */
  const quarters: PeriodOption[] = [];
  for (let back = 1; back <= 12; back++) {
    const months = (q - 1) * 3 - back * 3;
    const anchor = new Date(
      Date.UTC(
        market === 'US' ? fy : fy - 1,
        startMonth + months + 1, // mid-quarter, so month arithmetic cannot straddle
        15,
      ),
    );
    if (anchor < inception) break;

    const qq = fiscalQuarterOf(anchor, market);
    const qfy = fiscalYearOf(anchor, market);
    const code = fiscalQuarterCode(qq, qfy, market);
    const range = fiscalQuarterRange(qq, qfy, market);

    try {
      resolvePeriod(code, { asOf: day, market });
    } catch {
      continue; // zero-length once clamped — not a measurable period
    }

    quarters.push({
      code,
      label: fiscalQuarterLabel(qq, qfy, market),
      hint: `${fmt(range.start)} → ${fmt(range.end)}`,
      group: 'Quarters',
    });
  }

  /** Whole closed years, same logic: offered only when they resolve. */
  const years: PeriodOption[] = [];
  for (let back = 0; back <= 5; back++) {
    const y = fy - back;
    const range = fiscalYearRange(y, market);
    if (range.end < inception) break;
    // The live year is already covered by FYTD above.
    if (range.end >= day) continue;

    const code = fiscalYearCode(y, market);
    try {
      resolvePeriod(code, { asOf: day, market });
    } catch {
      continue;
    }

    years.push({
      code,
      label: fiscalYearLabel(y, market),
      hint: `${fmt(range.start)} → ${fmt(range.end)}`,
      group: 'Years',
    });
  }

  return [
    ...current,
    ...quarters,
    ...years,
    { code: 'CUSTOM', label: 'Custom range…', hint: 'Pick any two dates', group: 'Custom' },
  ];
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
  opts: { asOf?: Date; from?: Date; to?: Date; market?: Market } = {},
): ResolvedPeriod {
  const asOf = utcDay(opts.asOf ?? new Date());
  const inception = utcDay(INCEPTION_DATE);
  const market = opts.market ?? DEFAULT_MARKET;

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

    /**
     * A HISTORICAL window must have length, not merely a valid ordering.
     *
     * `to === from` is the case that matters and the one an ordering check
     * misses: the quarter inception closes (Q1 FY27, Apr–Jun 2026) clamps to
     * 30-June → 30-June. That is a single valuation compared against itself — a
     * guaranteed 0.00% that renders as a real quarterly result and would be read
     * as "the book was flat that quarter" rather than "this quarter is not
     * measurable". Rejecting it keeps it out of the dropdown, since
     * availablePeriods offers only what resolves.
     *
     * A LIVE window is the deliberate exception. On the first day of a month
     * MTD legitimately spans zero days, as do QTD and FYTD on their opening day
     * — and on those days the honest answer is "0.00%, nothing has happened
     * yet", not an error that blanks the page. The distinction is whether the
     * window is still running: a zero-length live window will have length
     * tomorrow, a zero-length closed one never will.
     */
    const live = rawTo >= asOf;
    if (to < from || (to.getTime() === from.getTime() && !live)) {
      throw new BadRequestException(
        `Period "${label}" spans no time once clamped: ${from.toISOString().slice(0, 10)} → ` +
          `${to.toISOString().slice(0, 10)}. The house has no priced history before ` +
          `${inception.toISOString().slice(0, 10)}, so this window has nothing to measure.`,
      );
    }

    /**
     * Report the shortfall, not just the fact of it.
     *
     * Only a genuine pull-FORWARD counts as lost days. The one-day anchor onto
     * inception (Q1's nominal 1-July start becoming the 30-June close) is not a
     * shortfall — it is the same valuation under two names — so it would be
     * misleading to tell the reader a day went missing.
     */
    const nominal = utcDay(rawFrom);
    const daysClamped = startsBeforeInception
      ? Math.round((from.getTime() - nominal.getTime()) / 86_400_000)
      : 0;

    return {
      period,
      label,
      from,
      to,
      clampedToInception,
      nominalFrom: daysClamped > 0 ? nominal : undefined,
      daysClamped,
      openPeriod,
    };
  };

  if (code === 'INCEPTION') {
    return clamp(inception, asOf, 'INCEPTION', 'Since inception');
  }

  if (code === 'MTD') {
    const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
    return clamp(from, asOf, 'MTD', 'Month to date');
  }

  /** The fiscal quarter in progress — Q2 FY27 on the Indian book today. */
  if (code === 'QTD') {
    const fy = fiscalYearOf(asOf, market);
    const q = fiscalQuarterOf(asOf, market);
    const { start } = fiscalQuarterRange(q, fy, market);
    return clamp(start, asOf, 'QTD', `${fiscalQuarterLabel(q, fy, market)} to date`);
  }

  /**
   * FYTD — from the previous financial year's closing date to today. On the
   * Indian book that is the 31-March close; on the US book it is 31-December,
   * which makes FYTD and CYTD the same window there, and that is correct rather
   * than redundant.
   */
  if (code === 'FYTD' || code === 'YTD') {
    const fy = fiscalYearOf(asOf, market);
    const { start } = fiscalYearRange(fy, market);
    return clamp(start, asOf, code, `${fiscalYearLabel(fy, market)} to date`);
  }

  /** CYTD — 31-December close to today, on either book. */
  if (code === 'CYTD') {
    const from = new Date(Date.UTC(asOf.getUTCFullYear(), 0, 1));
    return clamp(from, asOf, 'CYTD', 'Calendar year to date');
  }

  if (code === 'CUSTOM') {
    if (!opts.from) {
      throw new BadRequestException('A custom period needs ?from=YYYY-MM-DD.');
    }
    return clamp(opts.from, opts.to ?? asOf, 'CUSTOM', 'Custom range');
  }

  const quarter = QUARTER_CODE.exec(code);
  if (quarter) {
    const q = Number(quarter[1]);
    const m = marketForPrefix(quarter[2], market);
    const fy = 2000 + Number(quarter[3]);
    const { start, end } = fiscalQuarterRange(q, fy, m);
    return clamp(start, end, code, fiscalQuarterLabel(q, fy, m));
  }

  const year = YEAR_CODE.exec(code);
  if (year) {
    const m = marketForPrefix(year[1], market);
    const fy = 2000 + Number(year[2]);
    const { start, end } = fiscalYearRange(fy, m);
    return clamp(start, end, code, fiscalYearLabel(fy, m));
  }

  throw new BadRequestException(
    `Unknown period "${code}". Expected INCEPTION, MTD, QTD, FYTD, CYTD, CUSTOM, ` +
      `a quarter like Q2-FY27, or a year like FY27.`,
  );
}
