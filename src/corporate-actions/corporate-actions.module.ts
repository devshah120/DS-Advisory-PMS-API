/**
 * The Corporate Action Engine, wired.
 *
 * ── What this module imports, and what that says about coupling ─────────────
 *
 * PrismaModule and nothing else. The engine reads Holding, Transaction, Client
 * and AppSetting through Prisma directly and writes its own three collections;
 * it does NOT import HoldingsModule, TransactionsModule, ReportsModule or
 * PortfolioReconstructionModule, and none of them import it.
 *
 * That is what "modular and independent" (the brief's own words) buys: this
 * module can be removed from app.module.ts and every existing feature keeps
 * working, because nothing existing depends on it. The integration runs the
 * other way — the engine writes ordinary Transaction rows in the shape the
 * existing replay already understands, so Historical Reports and Performance
 * pick up corporate actions without either module knowing this one exists.
 *
 * ── Provider order is the fallback order (PART 32) ──────────────────────────
 *
 * The array bound to CORPORATE_ACTION_PROVIDERS is ordered by priority. Adding
 * an SEC or company-IR adapter later means writing the class and putting it
 * ABOVE FmpCorporateActionProvider here — no other file changes.
 */
import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { CorporateActionAuditService } from './audit.service';
import { CorporateActionScheduler } from './corporate-action.scheduler';
import { CorporateActionService } from './corporate-action.service';
import { CorporateActionValidator } from './corporate-action.validator';
import { CorporateActionsController } from './corporate-actions.controller';
import { BonusProcessor } from './processors/bonus.processor';
import { DelistingProcessor } from './processors/delisting.processor';
import { DividendProcessor } from './processors/dividend.processor';
import { MergerProcessor } from './processors/merger.processor';
import { ProcessorRegistry } from './processors/processor.registry';
import { RightsIssueProcessor } from './processors/rights-issue.processor';
import { SpinOffProcessor } from './processors/spin-off.processor';
import { StockSplitProcessor } from './processors/stock-split.processor';
import { TickerChangeProcessor } from './processors/ticker-change.processor';
import { FmpCorporateActionProvider } from './providers/fmp-corporate-action.provider';
import { CORPORATE_ACTION_PROVIDERS } from './providers/corporate-actions.tokens';
import { ReconciliationService } from './reconciliation.service';

@Module({
  imports: [PrismaModule],
  controllers: [CorporateActionsController],
  providers: [
    CorporateActionService,
    CorporateActionValidator,
    ReconciliationService,
    CorporateActionAuditService,
    CorporateActionScheduler,
    ProcessorRegistry,

    StockSplitProcessor,
    BonusProcessor,
    DividendProcessor,
    RightsIssueProcessor,
    SpinOffProcessor,
    MergerProcessor,
    TickerChangeProcessor,
    DelistingProcessor,

    FmpCorporateActionProvider,
    {
      provide: CORPORATE_ACTION_PROVIDERS,
      // Priority order — highest-tier source first. An SEC/company-IR adapter
      // belongs above FMP when one is written.
      useFactory: (fmp: FmpCorporateActionProvider) => [fmp],
      inject: [FmpCorporateActionProvider],
    },
  ],
  /**
   * Exported so a future consumer (a report section, say) can read corporate
   * actions without reaching into Prisma itself. Nothing exports the
   * PROCESSORS: applying an action is this module's responsibility alone, and
   * a caller that could invoke a processor directly could bypass the
   * transaction, the ledger and the idempotency key.
   */
  exports: [CorporateActionService],
})
export class CorporateActionsModule {}
