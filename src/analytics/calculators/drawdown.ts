import { MIN_OBSERVATIONS, MetricResult, insufficient, ok } from './types';
import { mean } from './statistics';

export interface DrawdownEpisode {
  peakDate: Date;
  peakValue: number;
  troughDate: Date;
  troughValue: number;
  maxDrawdown: number;
  /** null when the drawdown has not yet recovered. Not "recovered today". */
  recoveredAt: Date | null;
  recoveryDays: number | null;
  durationDays: number;
}

export interface DrawdownPoint {
  date: Date;
  drawdown: number;
}

export interface DrawdownAnalysis {
  maxDrawdown: number;
  currentDrawdown: number;
  averageDrawdown: number;
  longestRecoveryDays: number | null;
  inDrawdown: boolean;
  episodes: DrawdownEpisode[];
  underwater: DrawdownPoint[];
}

const DAY_MS = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

/**
 * Drawdown from a NAV series.
 *
 * NOTE the NAV series fed here must already be flow-adjusted (an index rebased
 * from flow-adjusted returns), NOT raw account value. A $75k deposit into a $150k
 * book raises raw NAV by 50% and resets the running peak, which silently erases
 * real drawdowns from the record.
 */
export function drawdownAnalysis(
  nav: number[],
  dates: Date[],
): MetricResult<DrawdownAnalysis> {
  if (nav.length < MIN_OBSERVATIONS.drawdown) {
    return insufficient(MIN_OBSERVATIONS.drawdown, nav.length, 'Drawdown analysis');
  }

  let peak = nav[0];
  let peakDate = dates[0];

  const underwater: DrawdownPoint[] = [];
  const episodes: DrawdownEpisode[] = [];
  let current: {
    peakDate: Date;
    peakValue: number;
    troughDate: Date;
    troughValue: number;
    maxDrawdown: number;
  } | null = null;

  for (let i = 0; i < nav.length; i++) {
    if (nav[i] > peak) {
      // A new high-water mark means any open episode has fully recovered.
      if (current) {
        episodes.push({
          ...current,
          recoveredAt: dates[i],
          recoveryDays: daysBetween(current.troughDate, dates[i]),
          durationDays: daysBetween(current.peakDate, dates[i]),
        });
        current = null;
      }
      peak = nav[i];
      peakDate = dates[i];
    }

    const dd = peak > 0 ? (nav[i] - peak) / peak : 0; // ≤ 0 by construction
    underwater.push({ date: dates[i], drawdown: dd });

    if (dd < 0) {
      if (!current) {
        current = {
          peakDate,
          peakValue: peak,
          troughDate: dates[i],
          troughValue: nav[i],
          maxDrawdown: dd,
        };
      } else if (dd < current.maxDrawdown) {
        // A deeper trough within the SAME episode — not a new episode.
        current.maxDrawdown = dd;
        current.troughDate = dates[i];
        current.troughValue = nav[i];
      }
    }
  }

  // An unrecovered drawdown stays open: recoveredAt is null, and it must NOT be
  // reported as recovered-today, which would flatter the recovery statistic.
  if (current) {
    episodes.push({
      ...current,
      recoveredAt: null,
      recoveryDays: null,
      durationDays: daysBetween(current.peakDate, dates[dates.length - 1]),
    });
  }

  const recovered = episodes.filter((e) => e.recoveryDays !== null);

  return ok(
    {
      maxDrawdown: Math.min(0, ...underwater.map((u) => u.drawdown)),
      currentDrawdown: underwater[underwater.length - 1].drawdown,
      // Mean of EPISODE troughs, not of every underwater day — the latter is
      // dominated by long shallow periods and understates severity.
      averageDrawdown: episodes.length ? mean(episodes.map((e) => e.maxDrawdown)) : 0,
      longestRecoveryDays: recovered.length
        ? Math.max(...recovered.map((e) => e.recoveryDays as number))
        : null,
      inDrawdown: current !== null,
      episodes,
      underwater,
    },
    nav.length,
  );
}

/** Rebases a flow-adjusted return series to an index starting at 100. */
export function rebaseToIndex(returns: number[], base = 100): number[] {
  const out: number[] = [base];
  for (let i = 1; i < returns.length; i++) {
    out.push(out[out.length - 1] * (1 + returns[i]));
  }
  return out;
}
