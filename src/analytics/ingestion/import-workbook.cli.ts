import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from '../../app.module';
import { WorkbookImportService } from './workbook-import.service';

/**
 * One-shot importer.
 *
 *   npm run import:workbook -- "../../Portfolio June 2026.xlsx"
 *
 * Idempotent — safe to re-run after a correction to the sheet.
 */
async function main() {
  const logger = new Logger('ImportWorkbook');

  const filePath =
    process.argv[2] ?? 'c:/Users/dev shah/Downloads/New folder/Portfolio June 2026.xlsx';
  const clientName = process.argv[3] ?? 'Atlas Global Fund';

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const importer = app.get(WorkbookImportService);
    const summary = await importer.import(filePath, clientName);

    logger.log('─'.repeat(60));
    logger.log(`Benchmarks   : ${summary.benchmarks}`);
    logger.log(`Instruments  : ${summary.instruments}`);
    logger.log(`Price bars   : ${summary.priceBars}`);
    logger.log(`Clients      : ${summary.clients}`);
    logger.log(`Holdings     : ${summary.holdings}`);
    logger.log(`Cash flows   : ${summary.transactions}`);

    if (summary.warnings.length) {
      logger.warn(`${summary.warnings.length} warning(s):`);
      for (const w of summary.warnings) logger.warn(`  - ${w}`);
    }
    logger.log('─'.repeat(60));
  } catch (err) {
    logger.error(`Import failed: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main();
