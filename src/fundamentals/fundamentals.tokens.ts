/**
 * DI token for the active FundamentalsProvider. Every consumer
 * (RefreshScheduler today; anything else added later) injects against this
 * token and the FundamentalsProvider interface — never against a concrete
 * class like FmpFundamentalsProvider directly. Swapping providers is
 * therefore a one-line change in FundamentalsModule's `providers` array:
 *
 *   { provide: FUNDAMENTALS_PROVIDER, useClass: FinnhubFundamentalsProvider }
 */
export const FUNDAMENTALS_PROVIDER = Symbol('FUNDAMENTALS_PROVIDER');
