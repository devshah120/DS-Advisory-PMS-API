import { Injectable } from '@nestjs/common';
import { EventSnapshot } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { WatchlistEvent } from '../market/events.service';

/**
 * The only class in the Event Center that touches Prisma for the event
 * snapshot. Mirrors ApiRepository in the Fundamentals Engine: the read path
 * (PortfolioEventsService) and the refresh path both go through here, so the
 * durable store can change without either of them knowing.
 */
@Injectable()
export class EventSnapshotRepository {
  constructor(private prisma: PrismaService) {}

  listAll(): Promise<EventSnapshot[]> {
    return this.prisma.eventSnapshot.findMany();
  }

  /**
   * Replaces the snapshot with a freshly-fetched calendar. The upstream no
   * longer listing an event (it fell out of the lookahead window, or a date
   * changed) must remove the stale row, so this is a full replace rather than
   * a blind upsert that would leave orphans behind forever.
   */
  async replaceAll(events: WatchlistEvent[], source = 'yahoo'): Promise<number> {
    const refreshedAt = new Date();

    // (ticker, type, date) is unique in the schema, but one ticker can produce
    // two DIVIDEND events on a single day — an issuer whose pay date falls on
    // the ex-date. First one wins rather than letting createMany throw and
    // lose the entire refresh over one collision.
    const byKey = new Map<string, WatchlistEvent>();
    for (const e of events) {
      const key = `${e.ticker}|${e.type}|${e.date}`;
      if (!byKey.has(key)) byKey.set(key, e);
    }

    const rows = [...byKey.values()].map((e) => ({
      ticker: e.ticker,
      type: e.type,
      code: e.code,
      label: e.label,
      date: e.date,
      status: e.status,
      source,
      refreshedAt,
    }));

    await this.prisma.$transaction([
      this.prisma.eventSnapshot.deleteMany({}),
      ...(rows.length ? [this.prisma.eventSnapshot.createMany({ data: rows })] : []),
    ]);

    return rows.length;
  }
}
