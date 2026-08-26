import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { OcrWord } from './types.js';

type PdfTextItem = {
  str: string;
  width: number;
  height: number;
  transform: number[];
  dir?: string;
  hasEOL?: boolean;
};

export type ExtractedPage = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  words: OcrWord[];
};

const clamp = (value: number) => Math.max(0, Math.min(1, value));

function orderAndLabelWords(words: OcrWord[], pageNumber: number) {
  const pending = [...words].sort((a, b) => {
    const vertical = (a.y + a.height / 2) - (b.y + b.height / 2);
    return Math.abs(vertical) > Math.max(a.height, b.height) * 0.45 ? vertical : a.x - b.x;
  });
  const lines: Array<{ center: number; height: number; words: OcrWord[] }> = [];

  for (const word of pending) {
    const center = word.y + word.height / 2;
    let best: typeof lines[number] | undefined;
    let distance = Number.POSITIVE_INFINITY;
    for (const line of lines) {
      const candidateDistance = Math.abs(center - line.center);
      if (candidateDistance <= Math.max(word.height, line.height) * 0.6 && candidateDistance < distance) {
        best = line;
        distance = candidateDistance;
      }
    }
    if (best) {
      best.words.push(word);
      best.center = best.words.reduce((sum, item) => sum + item.y + item.height / 2, 0) / best.words.length;
      best.height = Math.max(best.height, word.height);
    } else {
      lines.push({ center, height: word.height, words: [word] });
    }
  }

  lines.sort((a, b) => a.center - b.center);
  return lines.flatMap((line, lineIndex) => line.words
    .sort((a, b) => a.x - b.x)
    .map((word) => ({ ...word, blockId: `p${pageNumber}-pdf`, lineId: `p${pageNumber}-pdf-${lineIndex}` })));
}

export type ExtractOptions = {
  /**
   * Force-OCR replaces any embedded text, so parsing the content stream for
   * every page is wasted work. Only the page geometry is needed then.
   */
  withText?: boolean;
};

export async function extractPdfPages(filePath: string, options: ExtractOptions = {}): Promise<ExtractedPage[]> {
  const withText = options.withText ?? true;
  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = getDocument({ data, disableFontFace: true, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const pages: ExtractedPage[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    if (!withText) {
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, text: '', words: [] });
      page.cleanup();
      continue;
    }
    const content = await page.getTextContent();
    const words: OcrWord[] = [];

    for (const [itemIndex, raw] of content.items.entries()) {
      if (!('str' in raw)) continue;
      const item = raw as PdfTextItem;
      const tokenMatches = [...item.str.matchAll(/\S+/g)];
      if (!tokenMatches.length) continue;
      const baseX = item.transform[4] ?? 0;
      const baseY = item.transform[5] ?? 0;
      const angle = Math.atan2(item.transform[1] ?? 0, item.transform[0] ?? 1);
      const axis = { x: Math.cos(angle), y: Math.sin(angle) };
      const normal = { x: -axis.y, y: axis.x };
      const itemWidth = Math.max(Math.abs(item.width), 1);
      const itemHeight = Math.max(Math.abs(item.height), Math.hypot(item.transform[2] ?? 0, item.transform[3] ?? 0), 1);

      tokenMatches.forEach((match, tokenIndex) => {
        const token = match[0];
        const startRatio = (match.index ?? 0) / Math.max(item.str.length, 1);
        const endRatio = ((match.index ?? 0) + token.length) / Math.max(item.str.length, 1);
        const start = itemWidth * startRatio;
        const end = itemWidth * endRatio;
        const pdfCorners = [
          [baseX + axis.x * start, baseY + axis.y * start],
          [baseX + axis.x * end, baseY + axis.y * end],
          [baseX + axis.x * start + normal.x * itemHeight, baseY + axis.y * start + normal.y * itemHeight],
          [baseX + axis.x * end + normal.x * itemHeight, baseY + axis.y * end + normal.y * itemHeight],
        ];
        const corners = pdfCorners.map(([x, y]) => viewport.convertToViewportPoint(x ?? 0, y ?? 0));
        const left = Math.min(...corners.map(([x]) => x));
        const top = Math.min(...corners.map(([, y]) => y));
        const right = Math.max(...corners.map(([x]) => x));
        const bottom = Math.max(...corners.map(([, y]) => y));
        words.push({
          id: `p${pageNumber}-t${itemIndex}-w${tokenIndex}`,
          text: token,
          confidence: 100,
          x: clamp(left / viewport.width),
          y: clamp(top / viewport.height),
          width: clamp((right - left) / viewport.width),
          height: clamp((bottom - top) / viewport.height),
        });
      });
    }

    const orderedWords = orderAndLabelWords(words.filter((word) => word.width > 0 && word.height > 0), pageNumber);

    pages.push({
      pageNumber,
      width: viewport.width,
      height: viewport.height,
      text: orderedWords.map((word) => word.text).join(' '),
      words: orderedWords,
    });
    page.cleanup();
  }

  await loadingTask.destroy();
  return pages;
}
