/**
 * DI token for the ordered list of active corporate-action providers.
 *
 * Consumers inject `CorporateActionProvider[]` against this token — never a
 * concrete adapter class — so adding, removing or reordering sources is a
 * one-line change in CorporateActionsModule's `providers` array. The array's
 * ORDER is the fallback order (PART 32) and, combined with each adapter's
 * declared tier, decides which source wins a merge.
 *
 * Mirrors FUNDAMENTALS_PROVIDER in the fundamentals module, deliberately: this
 * codebase already has a convention for swappable data sources and a second,
 * different one would be a worse outcome than a slightly imperfect fit.
 */
export const CORPORATE_ACTION_PROVIDERS = Symbol('CORPORATE_ACTION_PROVIDERS');
