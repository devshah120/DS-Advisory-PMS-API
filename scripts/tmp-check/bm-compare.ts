import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PerformanceBaselineService } from '../../src/portfolio-reconstruction/performance-baseline.service';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { resolvePeriod } from '../../src/portfolio-reconstruction/periods';

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const svc = app.get(PerformanceBaselineService);
  const prisma = app.get(PrismaService);
  const c = await prisma.client.findFirst({ where: { name: 'Prashant Salecha', market: 'INDIA' } });
  const resolved = resolvePeriod('QTD', { market: 'INDIA', clientInception: c!.inceptionDate ?? undefined } as any);
  for (const code of [undefined, 'NIFTY500', 'SP500_INR', 'SP500']) {
    try {
      const r = await svc.periodReturn(c!.id, resolved, code);
      const f = (v: number | null | undefined) => (v == null ? 'n/a' : (v * 100).toFixed(2) + '%');
      console.log((code ?? '(default)').padEnd(10), 'bm', r.benchmark?.code, 'port', f(r.returnPct), 'bmRet', f(r.benchmark?.interim), 'alpha', f(r.alpha), 'assigned', r.assignedBenchmarkCode, r.benchmark?.reason ?? '');
    } catch (e: any) { console.log((code ?? '').padEnd(10), 'REJECTED:', e.message); }
  }
  await app.close();
})();
