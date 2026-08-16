import { Market } from '../common/market-scope';

/** Press coverage vs. a regulator-filed disclosure. */
export type NewsKind = 'NEWS' | 'FILING';

/**
 * Materiality tags. Deliberately a small closed set of the things that move a
 * position — not a topic taxonomy. Anything unmatched stays null and reads as
 * general coverage, which is honest about the fact that most headlines are.
 */
export type NewsTag =
  | 'RESULTS'
  | 'BUYBACK'
  | 'M&A'
  | 'DIVIDEND'
  | 'MANAGEMENT'
  | 'RATING'
  | 'ORDER';

/**
 * One story, normalized across all three upstreams (Yahoo, BSE, Google News)
 * before it reaches the repository. Providers differ wildly in shape — Yahoo
 * returns JSON with epoch seconds, BSE returns filing rows with a scrip code,
 * Google News returns RSS XML — so normalizing at the provider boundary keeps
 * every downstream consumer free of per-source branching.
 */
export interface NewsItem {
  ticker: string;
  market: Market;
  title: string;
  publisher: string;
  url: string;
  summary: string | null;
  publishedAt: Date;
  kind: NewsKind;
  category: string | null;
  tag: NewsTag | null;
  source: 'yahoo' | 'bse' | 'google-news';
}

/**
 * Headline patterns that mark a story as materially relevant.
 *
 * Ordered most-specific first and matched in order: "buyback of shares" is a
 * BUYBACK, not a generic corporate action, and an acquisition announced in a
 * results release should read as M&A. First match wins, so tightening a tag
 * means moving it up rather than making every pattern mutually exclusive.
 *
 * Patterns are written to cover both markets' vocabulary in one pass — Indian
 * filings say "outcome of board meeting" and "allotment", US wires say
 * "Q3 earnings" and "guidance" — because the alternative is two divergent
 * tables that drift.
 */
const TAG_PATTERNS: Array<[RegExp, NewsTag]> = [
  [/buy-?back|repurchase|tender offer/i, 'BUYBACK'],
  [/acquisit|acquires?|merger|amalgamat|takeover|divest|stake sale|joint venture/i, 'M&A'],
  [/dividend|interim payout|final payout/i, 'DIVIDEND'],
  [
    /results|earnings|quarterly|q[1-4]\b|financial results|profit|revenue|board meeting|outcome of/i,
    'RESULTS',
  ],
  [/resign|appoint|steps? down|new ceo|new cfo|managing director|board of directors/i, 'MANAGEMENT'],
  [/upgrade|downgrade|price target|initiat(e|ing) coverage|rating|outperform|underweight/i, 'RATING'],
  [/order win|bags? order|contract win|wins? contract|awarded|bags? deal/i, 'ORDER'],
];

/** The materiality tag for a headline, or null when nothing matches. */
export function deriveTag(title: string, category?: string | null): NewsTag | null {
  const text = category ? `${title} ${category}` : title;
  for (const [pattern, tag] of TAG_PATTERNS) {
    if (pattern.test(text)) return tag;
  }
  return null;
}
