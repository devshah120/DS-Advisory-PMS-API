/**
 * Recognises symbols that are pooled vehicles — country/region ETFs (EWQ,
 * MCHI), thematic/sector ETFs (ICLN, URNM), commodity trusts (CPER, GLD) and
 * closed-end/index funds — rather than operating companies.
 *
 * These have no revenue, no margins and no balance sheet of their own, so
 * every pillar the scoring engine computes is null and the row renders as a
 * meaningless 0. The primary provider (Finnhub) already declines to return a
 * profile for them, which is the real guard; this is the second line of
 * defence for providers that DO answer for funds — FMP's `profile` endpoint
 * happily returns a name and market cap for an ETF, which is exactly how the
 * pre-Finnhub snapshots for EWQ/URNM/ICLN/MCHI/CPER got written.
 *
 * Name matching is deliberately the LAST signal: an explicit `isEtf`/`isFund`
 * flag from the provider is trusted first when present.
 */

/**
 * Words that appear ONLY in a pooled vehicle's legal name, never in an
 * operating company's. These are conclusive on their own.
 */
const FUND_NAME_PATTERN =
  /\b(etf|etn|ucits|sicav|index fund|index trust|mutual fund|closed[- ]end fund|unit trust|commodity trust|currency trust|bullion)\b/i;

/**
 * Fund ISSUERS. Deliberately NOT conclusive alone: Invesco Ltd., Vanguard and
 * Amundi are themselves listed/operating companies with real fundamentals, so
 * matching an issuer name by itself would delete a legitimate holding (Invesco
 * Ltd. — IVZ — is the live example). An issuer name only indicates a fund when
 * it also carries a product word, as in "Invesco QQQ Trust".
 */
const FUND_ISSUER_PATTERN =
  /\b(ishares|spdr|vanguard|invesco|wisdomtree|proshares|direxion|sprott|global x|van ?eck|xtrackers|amundi|lyxor)\b/i;

/** Product words that turn an issuer name into a fund name. */
const FUND_PRODUCT_PATTERN = /\b(fund|trust|portfolio|shares|index|msci|ftse|s&p|nasdaq)\b/i;

/**
 * Industries FMP files pooled vehicles under. An operating asset manager
 * (BlackRock, Blackstone) also lands in "Asset Management", so this is never
 * sufficient ALONE — it only counts alongside a fund-shaped name.
 */
const FUND_INDUSTRY_PATTERN = /^asset management/i;

export interface FundProbe {
  symbol: string;
  company?: string | null;
  industry?: string | null;
  /** Provider-supplied flags, when the provider exposes them (FMP does). */
  isEtf?: boolean | null;
  isFund?: boolean | null;
}

/**
 * True when the symbol is a pooled vehicle rather than an operating company.
 *
 * Order matters: an explicit provider flag wins outright, then a fund-shaped
 * name, then a fund-shaped name-and-industry pairing. A company with real
 * fundamentals never trips any of these — BlackRock is "Asset Management" but
 * its name carries no fund-vehicle word.
 */
export function isFundVehicle(probe: FundProbe): boolean {
  if (probe.isEtf === true || probe.isFund === true) return true;

  const name = probe.company ?? '';
  if (FUND_NAME_PATTERN.test(name)) return true;

  // A fund issuer's name plus a product word ("iShares MSCI China", "Invesco
  // QQQ Trust") — but never the issuer alone, which is an operating company.
  if (FUND_ISSUER_PATTERN.test(name) && FUND_PRODUCT_PATTERN.test(name)) return true;

  // "United States Copper Index Fund" style names: the word "fund"/"trust"
  // alone is too weak on its own (Trust Bank, SVB Financial Trust), so it only
  // counts when the provider also filed it under an asset-management industry.
  if (/\b(fund|trust|portfolio)\b/i.test(name) && FUND_INDUSTRY_PATTERN.test(probe.industry ?? '')) {
    return true;
  }

  return false;
}
