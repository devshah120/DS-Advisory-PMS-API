import { Denominator, PortfolioSnapshot } from './types';
import { allocationBy, exposureProfile, weightOf } from './weights';

/** Thresholds from the brief. Overridable per client — a concentrated-by-design
 *  book run for an aggressive mandate should not scream red every morning. */
export interface ConcentrationLimits {
  position: { warn: number; high: number; critical: number };
  sector: { critical: number };
  industry: { critical: number };
}

export const DEFAULT_LIMITS: ConcentrationLimits = {
  position: { warn: 0.05, high: 0.07, critical: 0.1 },
  sector: { critical: 0.3 },
  industry: { critical: 0.2 },
};

export type Severity = 'warn' | 'high' | 'critical';

export interface Breach {
  kind: 'position' | 'sector' | 'industry';
  key: string;
  weight: number;
  limit: number;
  severity: Severity;
}

export interface ConcentrationReport {
  top5Weight: number;
  top10Weight: number;
  largestPosition: { ticker: string; weight: number } | null;
  largestSector: { key: string; weight: number } | null;
  largestIndustry: { key: string; weight: number } | null;
  largestCountry: { key: string; weight: number } | null;
  etfWeight: number;
  breaches: Breach[];
  denominator: Denominator;
}

export function concentrationReport(
  snap: PortfolioSnapshot,
  limits: ConcentrationLimits = DEFAULT_LIMITS,
  denominator: Denominator = 'TOTAL_ASSETS',
): ConcentrationReport {
  const profile = exposureProfile(snap, denominator);
  const sectors = allocationBy(snap, 'sector', { denominator });
  const industries = allocationBy(snap, 'industry', { denominator });
  const countries = allocationBy(snap, 'region', { denominator, lookThrough: true });

  const breaches: Breach[] = [];

  for (const p of snap.positions) {
    const w = weightOf(p.marketValue, snap, denominator);

    // Ordered most-severe first: a 12% position is one critical breach, not
    // three stacked breaches at 5%, 7% and 10%.
    const severity: Severity | null =
      w >= limits.position.critical ? 'critical'
      : w >= limits.position.high ? 'high'
      : w >= limits.position.warn ? 'warn'
      : null;

    if (severity) {
      const limit =
        severity === 'critical' ? limits.position.critical
        : severity === 'high' ? limits.position.high
        : limits.position.warn;
      breaches.push({ kind: 'position', key: p.ticker, weight: w, limit, severity });
    }
  }

  for (const s of sectors.slices) {
    // Cash is not a sector, and a large cash balance is not a concentration breach.
    if (s.key === 'Cash') continue;
    if (s.weight >= limits.sector.critical) {
      breaches.push({
        kind: 'sector',
        key: s.key,
        weight: s.weight,
        limit: limits.sector.critical,
        severity: 'critical',
      });
    }
  }

  for (const i of industries.slices) {
    if (i.key === 'Cash') continue;
    if (i.weight >= limits.industry.critical) {
      breaches.push({
        kind: 'industry',
        key: i.key,
        weight: i.weight,
        limit: limits.industry.critical,
        severity: 'critical',
      });
    }
  }

  const firstNonCash = (slices: Array<{ key: string; weight: number }>) =>
    slices.find((s) => s.key !== 'Cash') ?? null;

  return {
    top5Weight: profile.top5Weight,
    top10Weight: profile.top10Weight,
    largestPosition: profile.largestPosition
      ? { ticker: profile.largestPosition.ticker, weight: profile.largestPosition.weight }
      : null,
    largestSector: firstNonCash(sectors.slices),
    largestIndustry: firstNonCash(industries.slices),
    largestCountry: firstNonCash(countries.slices),
    etfWeight: profile.etfWeight,
    breaches: breaches.sort((a, b) => b.weight - a.weight),
    denominator,
  };
}
