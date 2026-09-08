/**
 * Action type -> processor. The single place that mapping is written down.
 *
 * PART 1 requires that new corporate-action types be addable later. With this
 * registry, adding one is: write a processor, add an enum value, add a line
 * here. Nothing in the service, the controller, the scheduler, the validator or
 * the schema changes — `details` (Json) absorbs any new type-specific fields.
 *
 * The registry deliberately THROWS on an unmapped type rather than falling back
 * to a no-op processor. An action type nobody wrote a processor for must fail
 * loudly at the point of processing: a silent no-op would mark it PROCESSED,
 * write a clean ledger row, change nothing, and leave the desk believing a
 * split had been applied.
 */
import { Injectable } from '@nestjs/common';
import { CorporateActionType } from '@prisma/client';
import { BonusProcessor } from './bonus.processor';
import { DelistingProcessor } from './delisting.processor';
import { DividendProcessor } from './dividend.processor';
import { MergerProcessor } from './merger.processor';
import { CorporateActionProcessor } from './processor.interface';
import { RightsIssueProcessor } from './rights-issue.processor';
import { SpinOffProcessor } from './spin-off.processor';
import { StockSplitProcessor } from './stock-split.processor';
import { TickerChangeProcessor } from './ticker-change.processor';

@Injectable()
export class ProcessorRegistry {
  private readonly registry: Partial<Record<CorporateActionType, CorporateActionProcessor>>;

  constructor(
    split: StockSplitProcessor,
    bonus: BonusProcessor,
    dividend: DividendProcessor,
    rights: RightsIssueProcessor,
    spinOff: SpinOffProcessor,
    merger: MergerProcessor,
    tickerChange: TickerChangeProcessor,
    delisting: DelistingProcessor,
  ) {
    this.registry = {
      // Forward and reverse splits are one calculation — see StockSplitProcessor.
      STOCK_SPLIT: split,
      REVERSE_SPLIT: split,

      // Bonus and stock dividend are the same event under two names: shares
      // issued from reserves for no consideration.
      BONUS_ISSUE: bonus,
      STOCK_DIVIDEND: bonus,

      // Every cash-per-share action. RETURN_OF_CAPITAL takes a different
      // accounting path INSIDE the processor (it reduces basis rather than
      // booking income) but shares the entitlement engine.
      DIVIDEND: dividend,
      SPECIAL_DIVIDEND: dividend,
      CASH_DISTRIBUTION: dividend,
      RETURN_OF_CAPITAL: dividend,

      RIGHTS_ISSUE: rights,
      SPIN_OFF: spinOff,

      MERGER: merger,
      ACQUISITION: merger,

      // Pure relabelling — no economic effect.
      TICKER_CHANGE: tickerChange,
      NAME_CHANGE: tickerChange,
      EXCHANGE_CHANGE: tickerChange,

      DELISTING: delisting,
    };
  }

  /** The processor for a type, or throws. */
  for(actionType: CorporateActionType): CorporateActionProcessor {
    const processor = this.registry[actionType];
    if (!processor) {
      throw new Error(
        `No processor registered for corporate action type ${actionType}. ` +
          'Register one in ProcessorRegistry before processing actions of this type.',
      );
    }
    return processor;
  }

  /** Whether a type can be processed at all — used by the UI to hide the button. */
  supports(actionType: CorporateActionType): boolean {
    return !!this.registry[actionType];
  }

  /** Every supported type, for the settings screen and API discovery. */
  supportedTypes(): CorporateActionType[] {
    return Object.keys(this.registry) as CorporateActionType[];
  }
}
