import ExcelJS from 'exceljs';
import type { z } from 'zod';
import type { findingsReportSchema } from './validation.js';
import { spreadsheetText } from './reportText.js';

type FindingsReport = z.infer<typeof findingsReportSchema>;

export async function createFindingsWorkbook(findings: FindingsReport['findings']) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Markwise';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Mentions', {
    views: [{ state: 'frozen', ySplit: 1 }],
    properties: { defaultRowHeight: 22 },
  });

  sheet.columns = [
    { header: 'PDF file', key: 'fileName', width: 38 },
    { header: 'Page', key: 'pageNumber', width: 10 },
    { header: 'Article / page title', key: 'title', width: 42 },
    { header: 'Keyword', key: 'keyword', width: 24 },
    { header: 'Matched text', key: 'matchedText', width: 32 },
    { header: 'Context', key: 'context', width: 70 },
    { header: 'Type', key: 'source', width: 13 },
    { header: 'OCR confidence', key: 'confidence', width: 17 },
    { header: 'Note', key: 'note', width: 36 },
  ];

  for (const finding of findings) {
    sheet.addRow({
      fileName: spreadsheetText(finding.fileName, 500),
      pageNumber: finding.pageNumber,
      title: spreadsheetText(finding.title, 1000),
      keyword: spreadsheetText(finding.keyword, 250),
      matchedText: spreadsheetText(finding.matchedText, 1000),
      context: spreadsheetText(finding.context, 4000),
      source: finding.source === 'AUTO' ? 'OCR match' : 'Manual',
      confidence: finding.confidence == null ? '' : Math.round(finding.confidence * 10) / 10,
      note: spreadsheetText(finding.note, 1000),
    });
  }

  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24563F' } };
  header.alignment = { vertical: 'middle' };
  header.eachCell((cell) => {
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF183B2C' } } };
  });

  sheet.autoFilter = { from: 'A1', to: 'I1' };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
    row.font = { name: 'Arial', size: 10 };
    if (rowNumber % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F2' } };
    }
  });

  const summary = workbook.addWorksheet('Summary');
  const files = new Set(findings.map((finding) => finding.fileName));
  const keywords = new Set(findings.map((finding) => finding.keyword));
  summary.addRows([
    ['Markwise findings report'],
    ['Generated', new Date().toISOString()],
    ['PDF files with matches', files.size],
    ['Keywords found', keywords.size],
    ['Total mentions', findings.length],
  ]);
  summary.getColumn(1).width = 28;
  summary.getColumn(2).width = 30;
  summary.getRow(1).font = { bold: true, size: 16, color: { argb: 'FF24563F' } };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
