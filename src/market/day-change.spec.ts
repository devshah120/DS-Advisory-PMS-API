import { MarketService } from './market.service';

/**
 * Regression cover for the movers board reporting a falling stock as the day's
 * top gainer.
 *
 * Yahoo omits whole settled sessions for thinly-traded NSE symbols, so the
 * daily bars either side of the hole span several days. Deriving the day change
 * from the last two bars turned a multi-day move into today's number — SYRMA
 * printed +10.34% on a day it actually fell. These tests pin the day change to
 * the quote metadata, which Yahoo resolves against its own trading calendar.
 */
describe('MarketService.dayChange', () => {
  const chart = (meta: Record<string, unknown>) => ({ chart: { result: [{ meta }] } });

  /** Stubs the private fetch helper, returning one response per URL requested. */
  function serviceReturning(...responses: Array<unknown>) {
    const svc = new MarketService();
    const urls: string[] = [];
    let i = 0;
    (svc as any).fetchJson = jest.fn(async (url: string) => {
      urls.push(url);
      return responses[Math.min(i++, responses.length - 1)];
    });
    return { svc, urls };
  }

  it('measures against the prior close from the quote, not the last daily bar', async () => {
    // The real SYRMA numbers from the day of the bug: Yahoo dropped the prior
    // session, whose close was 1634.8, leaving a stale 1457.30 bar behind it.
    const { svc } = serviceReturning(
      chart({ regularMarketPrice: 1605.2, chartPreviousClose: 1634.8 }),
    );

    const change = await svc.dayChange('SYRMA.NS');

    expect(change).not.toBeNull();
    expect(change!.priorClose).toBe(1634.8);
    expect(change!.changePercent).toBeCloseTo(-1.81, 2);
    // The defining symptom: a down day must never surface as a gain.
    expect(change!.changePercent).toBeLessThan(0);
  });

  it('retries a delisted .NS symbol on the BSE before giving up', async () => {
    // INDOSMC is BSE-only but stored with the '.NS' suffix the book uses;
    // without the retry it drops off the board entirely.
    const { svc, urls } = serviceReturning(
      { chart: { error: { code: 'Not Found' } } },
      chart({ regularMarketPrice: 497.2, chartPreviousClose: 484.45 }),
    );

    const change = await svc.dayChange('INDOSMC.NS');

    expect(change!.changePercent).toBeCloseTo(2.63, 2);
    expect(urls[1]).toContain('INDOSMC.BO');
  });

  it('reports no change rather than a fabricated 0% when the quote is unusable', async () => {
    // A missing or zero prior close makes the percentage meaningless; callers
    // drop the row instead of ranking a false flat.
    const { svc: noPrice } = serviceReturning(chart({ chartPreviousClose: 100 }));
    expect(await noPrice.dayChange('AAPL')).toBeNull();

    const { svc: zeroPrior } = serviceReturning(
      chart({ regularMarketPrice: 50, chartPreviousClose: 0 }),
    );
    expect(await zeroPrior.dayChange('AAPL')).toBeNull();
  });

  it('caches per ticker so one dashboard load does not refetch a shared holding', async () => {
    const { svc } = serviceReturning(
      chart({ regularMarketPrice: 110, chartPreviousClose: 100 }),
    );

    await svc.dayChange('RELIANCE.NS');
    await svc.dayChange('RELIANCE.NS');

    expect((svc as any).fetchJson).toHaveBeenCalledTimes(1);
  });
});
