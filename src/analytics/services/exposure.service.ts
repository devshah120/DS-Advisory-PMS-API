import { Injectable } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { Denominator, Dimension } from '../calculators/types';
import { allocationBy, exposureProfile } from '../calculators/weights';
import { DEFAULT_LIMITS, concentrationReport } from '../calculators/concentration';
import { diversificationScore } from '../calculators/diversification';

/**
 * Client-level cross-sectional analytics (brief §§1,2,3,4,7,8).
 *
 * These are thin: fetch the snapshot, call the pure calculator, attach the
 * response envelope. All the logic worth testing lives in `calculators/`.
 */
@Injectable()
export class ExposureService {
  constructor(private snapshots: SnapshotService) {}

  async allocation(
    clientId: string,
    dim: Dimension,
    opts: { lookThrough?: boolean; denominator?: Denominator } = {},
  ) {
    const snap = await this.snapshots.forClient(clientId);

    // Geography without look-through reports 0% China while MCHI is held, so it
    // defaults ON for region/country and OFF elsewhere (a stock's sector is its
    // own; only funds need decomposing).
    const lookThrough =
      opts.lookThrough ?? (dim === 'region' || dim === 'country');

    const result = allocationBy(snap, dim, { ...opts, lookThrough });

    return {
      data: result.slices,
      meta: {
        asOf: snap.asOf,
        dimension: dim,
        lookThrough,
        denominator: result.denominator,
        unclassifiedWeight: result.unclassifiedWeight,
        warnings:
          result.unclassifiedWeight > 0
            ? [
                `${(result.unclassifiedWeight * 100).toFixed(1)}% of the book is an ETF with no look-through map; its true exposure is not reflected here`,
              ]
            : [],
      },
    };
  }

  async exposure(clientId: string, denominator: Denominator = 'TOTAL_ASSETS') {
    const snap = await this.snapshots.forClient(clientId);
    const profile = exposureProfile(snap, denominator);

    return {
      data: profile,
      meta: { asOf: snap.asOf, denominator },
    };
  }

  async concentration(clientId: string) {
    const snap = await this.snapshots.forClient(clientId);
    const report = concentrationReport(snap, DEFAULT_LIMITS);

    return {
      data: report,
      meta: { asOf: snap.asOf, denominator: report.denominator, limits: DEFAULT_LIMITS },
    };
  }

  async diversification(clientId: string) {
    const snap = await this.snapshots.forClient(clientId);
    const score = diversificationScore(snap);

    return {
      data: score,
      meta: { asOf: snap.asOf },
    };
  }
}
