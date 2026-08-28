import { readFile } from 'node:fs/promises';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { applyLegacyEncodings, detectLegacyEncodings } from './reportText.js';
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
  /**
   * Set when the page's text layer was decoded out of a legacy font encoding.
   * The result is real Unicode, so the caller must not then reject it for
   * looking like the encoding it was just decoded from.
   */
  textRepaired?: boolean;
  /** Share of the page's characters that were dropped as unreadable. */
  unreadableRatio?: number;
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
    .map((word) => ({ ...word, lineId: `p${pageNumber}-pdf-${lineIndex}` })));
}

export type ExtractOptions = {
  /**
   * Force-OCR replaces any embedded text, so parsing the content stream for
   * every page is wasted work. Only the page geometry is needed then.
   */
  withText?: boolean;
};

/**
 * Repairs the legacy Azerbaijani font encodings on a whole page at once.
 *
 * The detectors need a run of text to tell a broken code page from ordinary
 * accented Latin, which a single word rarely provides -- so the decision is
 * made once from the page's own text and then applied word by word, keeping
 * every box aligned with the token it belongs to.
 */
/**
 * Characters a PDF can hand back that carry no readable text: the replacement
 * character, C0 controls, and the private-use area, where symbol fonts such as
 * Wingdings put their bullets and dingbats.
 */
const UNREADABLE_CHARACTERS = new RegExp('[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]', 'gu');

/**
 * Removes decorative and undecodable glyphs from the extracted words.
 *
 * A handful of private-use code points is normal in an otherwise perfect text
 * layer -- they are the list bullets. Treating their presence as proof the
 * layer is broken sent whole pages to the recogniser over two Wingdings
 * characters in ten thousand, which is why almost every page of some documents
 * was being read as a picture. They are dropped here instead, and the caller
 * decides from how many there were whether the layer is genuinely unusable.
 */
function stripUnreadable(words: OcrWord[]) {
  let removed = 0;
  const cleaned: OcrWord[] = [];
  for (const word of words) {
    const text = word.text.replace(UNREADABLE_CHARACTERS, () => { removed += 1; return ''; });
    if (text) cleaned.push(text === word.text ? word : { ...word, text });
  }
  return { words: cleaned, removed };
}

function repairPageWords(words: OcrWord[]) {
  const encodings = detectLegacyEncodings(words.map((word) => word.text).join(' '));
  if (!encodings.bytes && !encodings.cyrillic) return { words, repaired: false };
  return {
    words: words.map((word) => ({ ...word, text: applyLegacyEncodings(word.text, encodings) })),
    repaired: true,
  };
}

function readPageWords(page: any, viewport: any, pageNumber: number, content: any) {
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

  const repair = repairPageWords(words.filter((word) => word.width > 0 && word.height > 0));
  const stripped = stripUnreadable(repair.words);
  const characters = repair.words.reduce((total, word) => total + word.text.length, 0);
  return {
    words: orderAndLabelWords(stripped.words, pageNumber),
    repaired: repair.repaired,
    // The share of the page that was unreadable, for the usability decision.
    unreadableRatio: characters ? stripped.removed / characters : 0,
  };
}

/**
 * An open PDF that pages can be read from one at a time.
 *
 * The pipeline processes pages as independent jobs, so the document is parsed
 * once per worker batch and each page is pulled from it on demand, rather than
 * every page being built up front and held in memory until the last one is
 * finished.
 */
export type PdfHandle = {
  pageCount: number;
  readPage(pageNumber: number, options?: ExtractOptions): Promise<ExtractedPage>;
  close(): Promise<void>;
};

export async function openPdf(filePath: string): Promise<PdfHandle> {
  const data = new Uint8Array(await readFile(filePath));
  const loadingTask = getDocument({ data, disableFontFace: true, useSystemFonts: true });
  const pdf = await loadingTask.promise;

  return {
    pageCount: pdf.numPages,
    async readPage(pageNumber, options = {}) {
      const withText = options.withText ?? true;
      const page = await pdf.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: 1 });
        if (!withText) {
          return { pageNumber, width: viewport.width, height: viewport.height, text: '', words: [], textRepaired: false, unreadableRatio: 0 };
        }
        const content = await page.getTextContent();
        const { words, repaired, unreadableRatio } = readPageWords(page, viewport, pageNumber, content);
        return {
          pageNumber,
          width: viewport.width,
          height: viewport.height,
          text: words.map((word) => word.text).join(' '),
          words,
          textRepaired: repaired,
          unreadableRatio,
        };
      } finally {
        page.cleanup();
      }
    },
    async close() {
      await loadingTask.destroy();
    },
  };
}

export async function extractPdfPages(filePath: string, options: ExtractOptions = {}): Promise<ExtractedPage[]> {
  const pdf = await openPdf(filePath);
  try {
    const pages: ExtractedPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.pageCount; pageNumber += 1) {
      pages.push(await pdf.readPage(pageNumber, options));
    }
    return pages;
  } finally {
    await pdf.close();
  }
}
