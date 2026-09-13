import { Injectable } from '@nestjs/common';
import { jsPDF } from 'jspdf';
import { autoTable } from 'jspdf-autotable';
import { ReviewPack } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PortfolioHistoryService } from '../portfolio-reconstruction/portfolio-history.service';
import { ReviewPackAnalysisService } from './review-pack-analysis.service';
import { resolvePeriod } from '../portfolio-reconstruction/periods';
import { Market, parseMarket } from '../common/market-scope';
import { Actor } from '../common/ownership-scope';
import {
  CONTENT_W,
  COL_W,
  DANGER,
  drawBanner,
  drawFooter,
  drawIdentity,
  drawSectionTitle,
  fmtDate,
  GOLD,
  GOLD_FILL,
  GREY,
  GUTTER,
  HAIRLINE,
  INK,
  MARGIN,
  moneyFormatter,
  NAVY,
  newDoc,
  PAGE_W,
  pct,
  stampPageNumbers,
  STONE,
  SUCCESS,
  WHITE,
} from './pdf-chrome';

/**
 * Server-side PDF for the Automated Client Review Pack — spec §70.
 *
 * Structurally mirrors DS-Advisory-PMS/src/lib/reviewPackPdf.ts (the existing
 * frontend pack): same banner/identity/return-band/value-panel/allocation
 * layout, drawn with the same ported pdf-chrome.ts. It differs only in the
 * commentary block, which here is the three AI/template-generated sections
 * plus contributors/detractors tables, instead of one free-text box — spec
 * §72 replaces "Commentary (optional)" with structured AI commentary, but the
 * document's visual identity must not change.
 *
 * Runs entirely server-side so an approved pack can be downloaded (or, in a
 * later phase, emailed) without a browser in the loop.
 */
@Injectable()
export class ReviewPackPdfService {
  constructor(
    private prisma: PrismaService,
    private history: PortfolioHistoryService,
    private analysis: ReviewPackAnalysisService,
  ) {}

  async build(pack: ReviewPack): Promise<Buffer> {
    const actor: Actor = { id: pack.ownerId ?? 'system', role: 'SUPER_ADMIN' };
    const subjectType = pack.subjectType === 'FAMILY' ? 'family' : 'client';
    const resolved = resolvePeriod(pack.periodCode, { market: pack.market as Market });

    // Re-derive the position-level detail (holdings table, allocation) the
    // same way the analysis that produced this pack's numbers did — never a
    // second, independent calculation, just the same read repeated for the
    // PDF's presentation layer.
    const portfolioAnalysis = await this.analysis.analyse(subjectType, pack.subjectId, resolved, actor);

    const doc = newDoc();
    doc.setProperties({
      title: `Client Review Pack — ${portfolioAnalysis.subjectName} — ${portfolioAnalysis.periodLabel}`,
      author: 'Giriraj Global Consultants',
      subject: 'Client Review Pack',
    });

    const money = moneyFormatter(portfolioAnalysis.currency);
    const asOf = new Date();

    let y = drawBanner(doc, 'Client Review Pack');
    const subjectLabel =
      subjectType === 'family' ? `${portfolioAnalysis.subjectName} (household)` : portfolioAnalysis.subjectName;
    const windowLabel = `${portfolioAnalysis.periodLabel} · ${fmtDate(portfolioAnalysis.periodStart)} to ${fmtDate(portfolioAnalysis.periodEnd)}${portfolioAnalysis.openPeriod ? ' (period still open)' : ''}`;
    y = drawIdentity(doc, subjectLabel, asOf, windowLabel, y);

    y = this.drawReturnBand(doc, y, portfolioAnalysis);

    const valueY = this.drawValuePanel(doc, y, portfolioAnalysis, money);
    const allocY = this.drawAllocationPanel(doc, y, portfolioAnalysis);
    y = Math.max(valueY, allocY) + 16;

    y = this.drawCommentarySection(doc, y, 'Portfolio Commentary', pack.portfolioCommentary);
    y = this.drawCommentarySection(doc, y, 'Market & Macro', pack.macroCommentary);
    y = this.drawCommentarySection(doc, y, 'Portfolio Positioning', pack.positioningCommentary);

    y = this.drawContributors(doc, y, portfolioAnalysis, money);

    drawFooter(doc, y, portfolioAnalysis.currency, this.notes(portfolioAnalysis, pack), { legend: false });
    stampPageNumbers(doc);

    return Buffer.from(doc.output('arraybuffer'));
  }

  private drawReturnBand(doc: jsPDF, y: number, a: Awaited<ReturnType<ReviewPackAnalysisService['analyse']>>): number {
    const h = 72;
    doc.setFillColor(...STONE);
    doc.setDrawColor(...HAIRLINE);
    doc.setLineWidth(0.5);
    doc.rect(MARGIN, y, CONTENT_W, h, 'FD');

    const third = CONTENT_W / 3;
    const caption = (x: number, text: string) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...GREY);
      doc.text(text.toUpperCase(), x, y + 18);
    };

    caption(MARGIN + 12, `Return — ${a.periodLabel}`);
    if (a.portfolioReturnPct === null) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(...GREY);
      doc.text('Not available', MARGIN + 12, y + 42);
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7);
      doc.text(
        doc.splitTextToSize(a.returnUnavailableReason ?? 'No measurable period yet.', third - 22).slice(0, 2),
        MARGIN + 12,
        y + 54,
      );
    } else {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(24);
      doc.setTextColor(...(a.portfolioReturnPct >= 0 ? NAVY : DANGER));
      doc.text(`${a.portfolioReturnPct > 0 ? '+' : ''}${(a.portfolioReturnPct * 100).toFixed(2)}%`, MARGIN + 12, y + 44);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...GREY);
      doc.text('Money-weighted (XIRR), flow-adjusted', MARGIN + 12, y + 58);
    }

    doc.setDrawColor(...HAIRLINE);
    doc.line(MARGIN + third, y + 10, MARGIN + third, y + h - 10);
    doc.line(MARGIN + third * 2, y + 10, MARGIN + third * 2, y + h - 10);

    const cell = (i: number, label: string, value: string, sub: string, tone?: [number, number, number]) => {
      const x = MARGIN + third * i + 12;
      caption(x, label);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(15);
      doc.setTextColor(...(tone ?? INK));
      doc.text(value, x, y + 42);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(...GREY);
      doc.text(doc.splitTextToSize(sub, third - 24).slice(0, 2), x, y + 56);
    };

    cell(
      1,
      'Benchmark',
      a.benchmarkReturnPct === null ? '—' : `${a.benchmarkReturnPct > 0 ? '+' : ''}${(a.benchmarkReturnPct * 100).toFixed(2)}%`,
      a.benchmarkName ?? 'No benchmark configured',
    );

    cell(
      2,
      'Difference',
      a.differencePct === null ? '—' : `${a.differencePct > 0 ? '+' : ''}${(a.differencePct * 100).toFixed(2)}%`,
      a.differencePct === null ? 'Needs both figures above' : a.differencePct >= 0 ? 'Ahead of the benchmark' : 'Behind the benchmark',
      a.differencePct === null ? undefined : a.differencePct >= 0 ? SUCCESS : DANGER,
    );

    return y + h + 18;
  }

  private drawValuePanel(
    doc: jsPDF,
    y: number,
    a: Awaited<ReturnType<ReviewPackAnalysisService['analyse']>>,
    money: (n: number) => string,
  ): number {
    const rows: Array<[string, string, boolean]> = [
      ['Opening value', money(a.portfolioValueStart), false],
      ['Closing value', money(a.portfolioValueEnd), true],
      ['Of which cash', money(a.cashValue), false],
    ];
    if (a.investmentGainLoss !== null) {
      rows.splice(1, 0, ['Investment gain / loss', money(a.investmentGainLoss), false]);
    }

    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN, right: PAGE_W - MARGIN - COL_W },
      tableWidth: COL_W,
      theme: 'plain',
      head: [['PORTFOLIO VALUE', '']],
      body: rows.map(([l, v]) => [l, v]),
      headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 8, cellPadding: { top: 5, bottom: 5, left: 6, right: 6 } },
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: { top: 4.5, bottom: 4.5, left: 6, right: 6 }, lineColor: HAIRLINE, lineWidth: 0.4, textColor: INK },
      columnStyles: { 0: { cellWidth: COL_W * 0.58, textColor: GREY }, 1: { cellWidth: COL_W * 0.42, halign: 'right', fontStyle: 'bold' } },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const row = rows[data.row.index];
        if (row?.[2]) {
          data.cell.styles.fillColor = GOLD_FILL;
          data.cell.styles.fontStyle = 'bold';
          if (data.column.index === 0) data.cell.styles.textColor = NAVY;
        } else if (data.row.index % 2 === 0) {
          data.cell.styles.fillColor = STONE;
        }
      },
    });

    return (doc as any).lastAutoTable.finalY as number;
  }

  private drawAllocationPanel(
    doc: jsPDF,
    y: number,
    a: Awaited<ReturnType<ReviewPackAnalysisService['analyse']>>,
  ): number {
    const rows = a.topSectors.map((s) => [s.sector, pct(s.weight)]);
    if (a.cashWeight > 0) rows.push(['Cash & equivalents', pct(a.cashWeight)]);

    autoTable(doc, {
      startY: y,
      margin: { left: MARGIN + COL_W + GUTTER, right: MARGIN },
      tableWidth: COL_W,
      theme: 'plain',
      head: [['ALLOCATION', '']],
      body: rows.length ? rows : [['No open positions', '—']],
      headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 8, cellPadding: { top: 5, bottom: 5, left: 6, right: 6 } },
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: { top: 4.5, bottom: 4.5, left: 6, right: 6 }, lineColor: HAIRLINE, lineWidth: 0.4, textColor: INK },
      columnStyles: { 0: { cellWidth: COL_W * 0.66, textColor: GREY }, 1: { cellWidth: COL_W * 0.34, halign: 'right', fontStyle: 'bold' } },
      didParseCell: (data) => {
        if (data.section === 'body' && data.row.index % 2 === 0) data.cell.styles.fillColor = STONE;
      },
    });

    return (doc as any).lastAutoTable.finalY as number;
  }

  /** One AI/template-generated paragraph, boxed like the old adviser commentary. */
  private drawCommentarySection(doc: jsPDF, y: number, title: string, text: string | null): number {
    if (!text || !text.trim()) return y;

    const wrapped = doc.splitTextToSize(text.trim(), CONTENT_W - 24) as string[];
    const boxH = wrapped.length * 11 + 24;

    let cursor = drawSectionTitle(doc, title, y, boxH + 20);

    doc.setFillColor(...STONE);
    doc.setDrawColor(...GOLD);
    doc.setLineWidth(0.5);
    doc.rect(MARGIN, cursor, CONTENT_W, boxH, 'FD');
    doc.setFillColor(...GOLD);
    doc.rect(MARGIN, cursor, 2.5, boxH, 'F');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK);
    doc.text(wrapped, MARGIN + 14, cursor + 16);

    return cursor + boxH + 16;
  }

  private drawContributors(
    doc: jsPDF,
    y: number,
    a: Awaited<ReturnType<ReviewPackAnalysisService['analyse']>>,
    money: (n: number) => string,
  ): number {
    if (a.topContributors.length === 0 && a.topDetractors.length === 0) return y;

    let cursor = drawSectionTitle(doc, 'Key Contributors & Detractors', y, 100);

    const rows = [
      ...a.topContributors.map((c) => [c.symbol, `+${(c.portfolioContributionPct * 100).toFixed(2)}%`, money(c.pnlContribution)]),
      ...a.topDetractors.map((c) => [c.symbol, `${(c.portfolioContributionPct * 100).toFixed(2)}%`, money(c.pnlContribution)]),
    ];

    autoTable(doc, {
      startY: cursor,
      margin: { left: MARGIN, right: MARGIN },
      tableWidth: CONTENT_W,
      theme: 'plain',
      head: [['Symbol', 'Contribution to return', 'P&L']],
      body: rows,
      headStyles: { fillColor: NAVY, textColor: WHITE, fontStyle: 'bold', fontSize: 8, cellPadding: { top: 5, bottom: 5, left: 6, right: 6 } },
      styles: { font: 'helvetica', fontSize: 8.5, cellPadding: { top: 4, bottom: 4, left: 6, right: 6 }, lineColor: HAIRLINE, lineWidth: 0.4, textColor: INK },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      didParseCell: (data) => {
        if (data.section !== 'body') return;
        const isContributor = data.row.index < a.topContributors.length;
        if (data.column.index === 1) data.cell.styles.textColor = isContributor ? SUCCESS : DANGER;
      },
    });

    return (doc as any).lastAutoTable.finalY as number;
  }

  private notes(a: Awaited<ReturnType<ReviewPackAnalysisService['analyse']>>, pack: ReviewPack): string[] {
    const notes: string[] = [];
    if (a.openPeriod) {
      notes.push('This period has not closed. The return above is measured to today and will change before the period ends.');
    }
    if (a.portfolioReturnPct !== null) {
      notes.push('Returns are money-weighted (XIRR) and adjusted for deposits and withdrawals.');
    }
    if (pack.subjectType === 'FAMILY') {
      notes.push('Household figures are computed over the combined cash flows of every member account, not as an average of the individual account returns.');
    }
    notes.push('Market data sources: as applicable, per the firm\'s market data and macro data providers.');
    return notes;
  }
}
