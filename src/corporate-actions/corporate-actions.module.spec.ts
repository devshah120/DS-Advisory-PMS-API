/**
 * Dependency-injection boot check.
 *
 * A missing provider, a circular import or a mis-bound token is invisible to
 * `tsc` and to every unit test in this suite — it surfaces only when Nest
 * builds the injector, which in production means at server start. Compiling
 * the module graph here turns "the API fails to boot" into a failing test.
 *
 * Prisma is overridden with a stub: this asserts that the WIRING resolves, not
 * that a database is reachable, and requiring a live MongoDB would make the
 * check unrunnable in CI for reasons that have nothing to do with what it is
 * testing.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../common/prisma/prisma.service';
import { CorporateActionsModule } from './corporate-actions.module';
import { CorporateActionService } from './corporate-action.service';
import { CorporateActionScheduler } from './corporate-action.scheduler';
import { CorporateActionValidator } from './corporate-action.validator';
import { ReconciliationService } from './reconciliation.service';
import { CorporateActionAuditService } from './audit.service';
import { ProcessorRegistry } from './processors/processor.registry';
import { CORPORATE_ACTION_PROVIDERS } from './providers/corporate-actions.tokens';
import type { CorporateActionProvider } from './providers/corporate-action-provider.interface';

describe('CorporateActionsModule (DI graph)', () => {
  const buildModule = () =>
    Test.createTestingModule({ imports: [CorporateActionsModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

  it('compiles — every provider resolves', async () => {
    const moduleRef = await buildModule();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  });

  it('resolves every service the engine exposes', async () => {
    const moduleRef = await buildModule();

    expect(moduleRef.get(CorporateActionService)).toBeInstanceOf(CorporateActionService);
    expect(moduleRef.get(CorporateActionValidator)).toBeInstanceOf(CorporateActionValidator);
    expect(moduleRef.get(ReconciliationService)).toBeInstanceOf(ReconciliationService);
    expect(moduleRef.get(CorporateActionAuditService)).toBeInstanceOf(CorporateActionAuditService);
    expect(moduleRef.get(CorporateActionScheduler)).toBeInstanceOf(CorporateActionScheduler);

    await moduleRef.close();
  });

  it('binds at least one provider against the fallback token', async () => {
    const moduleRef = await buildModule();
    const providers = moduleRef.get<CorporateActionProvider[]>(CORPORATE_ACTION_PROVIDERS);

    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    // Every entry must actually implement the interface, or the scheduler will
    // fail at 2am rather than here.
    for (const p of providers) {
      expect(typeof p.name).toBe('string');
      expect(typeof p.getCorporateActions).toBe('function');
      expect(typeof p.getDividends).toBe('function');
      expect(typeof p.getSplits).toBe('function');
      expect(typeof p.getMergers).toBe('function');
      expect(typeof p.getSymbolChanges).toBe('function');
    }

    await moduleRef.close();
  });

  /**
   * PART 1's extensibility requirement, asserted rather than assumed: every
   * action type the schema can express must have a processor, or approving one
   * would fail at the moment of processing.
   */
  it('registers a processor for every corporate action type', async () => {
    const moduleRef = await buildModule();
    const registry = moduleRef.get(ProcessorRegistry);

    const ALL_TYPES = [
      'STOCK_SPLIT',
      'REVERSE_SPLIT',
      'BONUS_ISSUE',
      'SPECIAL_DIVIDEND',
      'DIVIDEND',
      'STOCK_DIVIDEND',
      'RIGHTS_ISSUE',
      'SPIN_OFF',
      'MERGER',
      'ACQUISITION',
      'TICKER_CHANGE',
      'NAME_CHANGE',
      'EXCHANGE_CHANGE',
      'DELISTING',
      'CASH_DISTRIBUTION',
      'RETURN_OF_CAPITAL',
    ] as const;

    for (const type of ALL_TYPES) {
      expect(registry.supports(type)).toBe(true);
      expect(registry.for(type)).toBeDefined();
    }

    expect(registry.supportedTypes()).toHaveLength(ALL_TYPES.length);

    await moduleRef.close();
  });

  it('throws for an unregistered type rather than silently doing nothing', async () => {
    const moduleRef = await buildModule();
    const registry = moduleRef.get(ProcessorRegistry);

    expect(() => registry.for('NOT_A_REAL_TYPE' as never)).toThrow(/No processor registered/);

    await moduleRef.close();
  });
});
