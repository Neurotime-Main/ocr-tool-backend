import { randomUUID } from 'node:crypto';
import { prisma } from './db.js';
import { cleanReportText } from './reportText.js';
import type { HighlightInput, OcrWord } from './types.js';

type PageData = { pageNumber: number; words: unknown };
type StoredHighlight = HighlightInput & { id: string; documentId: string };

export type ReportFinding = {
  fileName: string;
  pageNumber: number;
  title: string;
  keyword: string;
  matchedText: string;
  context: string;
  source: 'AUTO' | 'MANUAL';
  note: string;
  confidence: number | null;
};

const normalize = (value: string) => value
  .toLocaleLowerCase()
  .normalize('NFKD')
  .replace(/\p{M}/gu, '')
  .replace(/ı/g, 'i')
  .replace(/ə/g, 'e')
  .replace(/(^[^\p{L}\p{N}\p{Pd}]+|[^\p{L}\p{N}\p{Pd}]+$)/gu, '');

function groupWordsIntoLines(words: OcrWord[]) {
  const identified = new Map<string, OcrWord[]>();
  const unassigned: OcrWord[] = [];
  for (const word of words) {
    if (!word.lineId) { unassigned.push(word); continue; }
    const line = identified.get(word.lineId) ?? [];
    line.push(word);
    identified.set(word.lineId, line);
  }
  const lines = [...identified.values()];
  for (const word of unassigned.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const center = word.y + word.height / 2;
    const line = lines.find((candidate) => {
      const candidateCenter = candidate.reduce((sum, item) => sum + item.y + item.height / 2, 0) / candidate.length;
      return Math.abs(center - candidateCenter) <= Math.max(word.height, ...candidate.map((item) => item.height)) * 0.65;
    });
    if (line) line.push(word);
    else lines.push([word]);
  }
  return lines.map((line) => line.sort((a, b) => a.x - b.x)).sort((a, b) => {
    const aTop = Math.min(...a.map((word) => word.y));
    const bTop = Math.min(...b.map((word) => word.y));
    return aTop - bTop || a[0]!.x - b[0]!.x;
  });
}

const isDash = (value: string) => /\p{Pd}/u.test(value);

function isHyphenatedFragment(lines: OcrWord[][], lineIndex: number, wordIndex: number) {
  const line = lines[lineIndex]!;
  const word = line[wordIndex]!;
  if (isDash(word.text.slice(0, 1)) || isDash(word.text.slice(-1))) return true;
  const previous = lineIndex > 0 ? lines[lineIndex - 1]!.at(-1) : undefined;
  const next = lineIndex < lines.length - 1 ? lines[lineIndex + 1]![0] : undefined;
  if (wordIndex === 0 && previous && isDash(previous.text.slice(-1))) return true;
  if (wordIndex === line.length - 1 && next && isDash(next.text.slice(0, 1))) return true;
  return false;
}

function box(words: OcrWord[]) {
  const x = Math.min(...words.map((word) => word.x));
  const y = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.width));
  const bottom = Math.max(...words.map((word) => word.y + word.height));
  return { x, y, width: right - x, height: bottom - y };
}

export function findPageMatches(page: PageData, keywords: string[], documentId: string) {
  const words = page.words as OcrWord[];
  const lines = groupWordsIntoLines(words);
  const matches: StoredHighlight[] = [];
  for (const keyword of keywords) {
    const query = keyword.split(/\s+/).map(normalize).filter(Boolean);
    if (!query.length) continue;
    for (const [lineIndex, line] of lines.entries()) {
      const normalizedWords = line.map((word) => normalize(word.text));
      for (let index = 0; index <= normalizedWords.length - query.length; index += 1) {
        if (!query.every((token, offset) => normalizedWords[index + offset] === token)) continue;
        const occurrence = line.slice(index, index + query.length);
        if (occurrence.some((_word, offset) => isHyphenatedFragment(lines, lineIndex, index + offset))) continue;
        matches.push({
          id: randomUUID(),
          documentId,
          pageNumber: page.pageNumber,
          ...box(occurrence),
          color: '#FACC15',
          opacity: 0.42,
          source: 'AUTO',
          keyword,
          note: null,
        });
        index += query.length - 1;
      }
    }
  }
  return matches;
}

export async function searchDocuments(documentIds: string[], keywords: string[]) {
  const results: Array<{ documentId: string; highlights: unknown[] }> = [];
  for (const documentId of documentIds) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: { id: true, ocrStatus: true, pages: { select: { pageNumber: true, words: true }, orderBy: { pageNumber: 'asc' } } },
    });
    if (!document || document.ocrStatus !== 'COMPLETE') continue;
    const automatic = document.pages.flatMap((page) => findPageMatches(page, keywords, document.id));
    const highlights = await prisma.$transaction(async (tx) => {
      await tx.highlight.deleteMany({ where: { documentId, source: 'AUTO' } });
      if (automatic.length) await tx.highlight.createMany({ data: automatic });
      return tx.highlight.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
    });
    results.push({ documentId, highlights });
  }
  return results;
}

function lineText(line: OcrWord[]) {
  const ordered = [...line].sort((a, b) => a.x - b.x);
  const text = ordered.reduce((value, word, index) => {
    if (!index) return word.text;
    const previous = ordered[index - 1]!;
    const gap = word.x - (previous.x + previous.width);
    // PDF text items often divide a single word into several glyph runs. If
    // their boxes touch, rejoin them; normal word spaces remain untouched.
    const joinsPrevious = gap <= Math.min(previous.height, word.height) * 0.08;
    return `${value}${joinsPrevious ? '' : ' '}${word.text}`;
  }, '');
  return cleanReportText(text, 4000);
}
const overlap = (word: OcrWord, highlight: StoredHighlight) => {
  const width = Math.max(0, Math.min(word.x + word.width, highlight.x + highlight.width) - Math.max(word.x, highlight.x));
  const height = Math.max(0, Math.min(word.y + word.height, highlight.y + highlight.height) - Math.max(word.y, highlight.y));
  return width * height;
};

function fallbackTitleFromPageText(pageText: string) {
  return pageText
    .split(/\r?\n/)
    .map((line) => cleanReportText(line, 250))
    .find((line) => line.length >= 3 && /\p{L}/u.test(line)) ?? '';
}

function findingDetails(words: OcrWord[], highlight: StoredHighlight, pageText: string) {
  const lines = groupWordsIntoLines(words);
  const matchedWords = words.filter((word) => overlap(word, highlight) > 0).sort((a, b) => a.y - b.y || a.x - b.x);
  const matchedIds = new Set(matchedWords.map((word) => word.id));
  let matchLineIndex = lines.findIndex((line) => line.some((word) => matchedIds.has(word.id)));
  if (matchLineIndex < 0) matchLineIndex = Math.max(0, lines.findIndex((line) => Math.max(...line.map((word) => word.y)) >= highlight.y));
  const context = lines.slice(Math.max(0, matchLineIndex - 1), matchLineIndex + 2).map(lineText).filter(Boolean).join(' ').slice(0, 4000);
  const heights = words.map((word) => word.height).filter(Boolean).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] ?? 0.015;
  const headings = lines.map((line, index) => {
    const text = lineText(line);
    const bottom = Math.max(...line.map((word) => word.y + word.height));
    const height = line.reduce((sum, word) => sum + word.height, 0) / line.length;
    const distance = highlight.y - bottom;
    return { index, text, bottom, height, distance };
  }).filter((line) => line.index < matchLineIndex && line.bottom <= highlight.y + .01 && line.distance <= .35
    && line.text.length >= 3 && line.text.length <= 250
    && (line.height >= median * 1.16 || line.text === line.text.toLocaleUpperCase()))
    .sort((a, b) => b.height - a.height || a.distance - b.distance);
  const fallback = lines.map((line) => ({
    text: lineText(line),
    top: Math.min(...line.map((word) => word.y)),
    height: Math.max(...line.map((word) => word.height)),
  })).filter((line) => line.top < .4 && line.text.length >= 3 && line.text.length <= 250 && line.height >= median * 1.2)
    .sort((a, b) => b.height - a.height || a.top - b.top)[0];
  return {
    title: headings[0]?.text ?? fallback?.text ?? fallbackTitleFromPageText(pageText),
    matchedText: lineText(matchedWords).slice(0, 1000),
    context,
    confidence: matchedWords.length ? matchedWords.reduce((sum, word) => sum + word.confidence, 0) / matchedWords.length : null,
  };
}

export async function buildStoredFindings(documentIds: string[]): Promise<ReportFinding[]> {
  const findings: ReportFinding[] = [];
  for (const documentId of documentIds) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      select: {
        originalName: true,
        pages: { select: { pageNumber: true, words: true, text: true } },
        highlights: { where: { source: 'AUTO' }, orderBy: [{ pageNumber: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!document) continue;
    const pages = new Map(document.pages.map((page) => [page.pageNumber, { words: page.words as OcrWord[], text: page.text }]));
    for (const highlight of document.highlights) {
      const page = pages.get(highlight.pageNumber);
      const details = findingDetails(page?.words ?? [], highlight as StoredHighlight, page?.text ?? '');
      findings.push({
        fileName: document.originalName,
        pageNumber: highlight.pageNumber,
        title: details.title,
        keyword: highlight.keyword ?? '',
        matchedText: details.matchedText || highlight.keyword || '',
        context: details.context,
        source: 'AUTO',
        note: highlight.note ?? '',
        confidence: details.confidence,
      });
    }
  }
  return findings;
}
