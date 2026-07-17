import { Injectable } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { allocationBy, exposureProfile, totalAssets } from '../calculators/weights';
import { concentrationReport } from '../calculators/concentration';
import {
  HeatmapDimension,
  HeatmapMetric,
  heatmap,
  overlapMatrix,
} from '../calculators/overlap';

/**
 * House-level analytics (brief §§5, 6, 12).
 *
 * Every allocation here calls the SAME `allocationBy` the client-level service
 * calls — just with the merged house snapshot. Client and house sector
 * allocation cannot drift apart, because there is only one implementation of it.
 */
@Injectable()
export class HouseService {
  constructor(private snapshots: SnapshotService) {}

  async exposure() {
    const house = await this.snapshots.houseSnapshot();
    const snaps = await this.snapshots.forAllClients();

    const profile = exposureProfile(house);
    const sectors = allocationBy(house, 'sector');
    const industries = allocationBy(house, 'industry');
    const regions = allocationBy(house, 'region', { lookThrough: true });

    // Per-ticker rollup: total shares, value, and how many clients hold it.
    const clientsPerTicker = new Map<string, number>();
    for (const s of snaps) {
      for (const p of s.positions) {
        clientsPerTicker.set(p.ticker, (clientsPerTicker.get(p.ticker) ?? 0) + 1);
      }
    }

    const positions = house.positions
      .map((p) => ({
        ticker: p.ticker,
        company: p.company,
        totalShares: p.quantity,
        totalValue: p.marketValue,
        houseWeight: p.marketValue / totalAssets(house),
        clientsHolding: clientsPerTicker.get(p.ticker) ?? 0,
        unrealizedPnl: p.unrealizedPnl,
      }))
      .sort((a, b) => b.totalValue - a.totalValue);

    return {
      data: {
        totalAUM: totalAssets(house),
        totalClients: snaps.length,
        totalPositions: house.positions.length,
        cashWeight: profile.cashWeight,
        stockWeight: profile.stockWeight,
        etfWeight: profile.etfWeight,
        sectors: sectors.slices,
        industries: industries.slices,
        regions: regions.slices,
        positions,
      },
      meta: {
        asOf: house.asOf,
        denominator: sectors.denominator,
        unclassifiedWeight: regions.unclassifiedWeight,
      },
    };
  }

  async overlap() {
    const snaps = await this.snapshots.forAllClients();
    return {
      data: overlapMatrix(snaps),
      meta: { asOf: new Date(), clientCount: snaps.length },
    };
  }

  async heatmap(rows: HeatmapDimension, cols: HeatmapDimension, metric: HeatmapMetric) {
    const snaps = await this.snapshots.forAllClients();
    return {
      data: heatmap(snaps, rows, cols, metric),
      meta: { asOf: new Date(), rows, cols, metric, sparse: true },
    };
  }

  async concentration() {
    const house = await this.snapshots.houseSnapshot();
    const report = concentrationReport(house);
    return { data: report, meta: { asOf: house.asOf } };
  }
}
