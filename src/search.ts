import { randomUUID } from 'node:crypto';
import { getDocument, highlightsOf, pagesOf, replaceAutoHighlights } from './store.js';
import { normalizeForSearch, normalizeToken } from './normalize.js';
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

function box(words: OcrWord[]) {
  const x = Math.min(...words.map((word) => word.x));
  const y = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.width));
  const bottom = Math.max(...words.map((word) => word.y + word.height));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * A line reduced to comparable letters, with a map back to the words.
 *
 * Every character kept records which word it came from, so a match found in
 * the flattened string can be turned back into the set of word boxes to
 * highlight. Word starts and ends are recorded too, because a match is only
 * accepted where it begins at the start of a word and finishes at the end of
 * one.
 */
type FlatLine = {
  text: string;
  owner: number[];
  startsWord: boolean[];
  endsWord: boolean[];
  /** Per word: the real word it belongs to runs on past this box. */
  continuesBefore: boolean[];
  continuesAfter: boolean[];
  words: OcrWord[];
};

/** A word broken across lines keeps its hyphen: `azal-` / `dilmasi`. */
const TRAILING_DASH = /\p{Pd}$/u;

/**
 * Below this fraction of the text height, the space between two boxes is not a
 * space at all -- they are two glyph runs of one word.
 */
const GLUED_GAP = 0.08;

function flattenLine(line: OcrWord[], previousLine?: OcrWord[]): FlatLine {
  let text = '';
  const owner: number[] = [];
  const startsWord: boolean[] = [];
  const endsWord: boolean[] = [];

  // Whether each box is really the whole word, or part of one. A PDF text layer
  // splits a word wherever the font changes, and a justified column hyphenates
  // across lines; in both cases the pieces sit flush against each other with no
  // room for a space. Without this, "azal" matches inside "azaltmaq" and across
  // "azal-" / "dilmasi", because each fragment starts and ends a box.
  const continuesBefore = line.map(() => false);
  const continuesAfter = line.map(() => false);
  for (let index = 0; index < line.length - 1; index += 1) {
    const left = line[index]!;
    const right = line[index + 1]!;
    const gap = right.x - (left.x + left.width);
    const scale = Math.max(left.height, right.height, Number.EPSILON);
    if (gap < scale * GLUED_GAP) {
      continuesAfter[index] = true;
      continuesBefore[index + 1] = true;
    }
  }
  // A hyphen at the end of the line means the word finishes on the next one.
  const last = line.length - 1;
  if (last >= 0 && TRAILING_DASH.test(line[last]!.text.trim())) continuesAfter[last] = true;
  // ...and the line after a hyphenated one opens mid-word.
  if (line.length && previousLine?.length) {
    const previous = previousLine[previousLine.length - 1]!;
    if (TRAILING_DASH.test(previous.text.trim())) continuesBefore[0] = true;
  }

  line.forEach((word, wordIndex) => {
    const normalized = normalizeForSearch(word.text);
    for (let index = 0; index < normalized.length; index += 1) {
      text += normalized[index];
      owner.push(wordIndex);
      startsWord.push(index === 0);
      endsWord.push(index === normalized.length - 1);
    }
  });
  return { text, owner, startsWord, endsWord, continuesBefore, continuesAfter, words: line };
}

/**
 * Finds every occurrence of each keyword on a page and returns a highlight for
 * each.
 *
 * Matching is done on the line's letters with the spaces taken out, rather than
 * word by word. These documents are typeset in justified newspaper columns that
 * break words across syllables -- `şəbəkələrdən` is set as `şə bə kə lər dən`
 * -- and PDF text layers routinely split one word into several glyph runs, so a
 * word-by-word comparison silently misses matches that are plainly visible on
 * the page. Requiring the match to fill whole words -- and those words not to
 * be fragments glued to a neighbour -- keeps that from over-matching into the
 * middle of longer words, so "azal" finds the airline and not "azaltmaq".
 */
export function findPageMatches(page: PageData, keywords: string[], documentId: string) {
  const words = page.words as OcrWord[];
  if (!words?.length) return [];
  const grouped = groupWordsIntoLines(words);
  const lines = grouped.map((line, index) => flattenLine(line, grouped[index - 1]));
  const matches: StoredHighlight[] = [];

  for (const keyword of keywords) {
    const needle = normalizeForSearch(keyword);
    if (!needle) continue;
    for (const line of lines) {
      let from = 0;
      for (;;) {
        const at = line.text.indexOf(needle, from);
        if (at === -1) break;
        from = at + 1;
        const end = at + needle.length - 1;
        // The match has to fill whole words, and those words must not be
        // fragments of a longer one.
        if (!line.startsWord[at] || !line.endsWord[end]) continue;
        if (line.continuesBefore[line.owner[at]!] || line.continuesAfter[line.owner[end]!]) continue;
        const covered = new Set(line.owner.slice(at, end + 1));
        const occurrence = [...covered].sort((a, b) => a - b).map((index) => line.words[index]!);
        if (!occurrence.length) continue;
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
        from = end + 1;
      }
    }
  }
  return matches;
}

/**
 * Runs a keyword search across a batch of documents.
 *
 * The candidate pages are chosen in the database first. `searchText` holds each
 * page's letters in the same normalised, space-free form the matcher compares
 * against, so a page that cannot contain a keyword is ruled out on a trigram
 * index instead of having its word boxes shipped to this process to find out.
 * On a thirty-document batch that is the difference between loading every page
 * in the workspace and loading the handful that actually matched.
 *
 * Pages still being recognised are simply not in the result yet, which is what
 * lets a batch be searched while the rest of it is still being read.
 */
export async function searchDocuments(documentIds: string[], keywords: string[]) {
  const needles = [...new Set(keywords.map(normalizeForSearch).filter(Boolean))];
  if (!needles.length) {
    return documentIds.map((documentId) => ({ documentId, highlights: [] }));
  }

  // The cheap filter first: a page whose normalised text holds none of the
  // needles cannot produce a match, and ruling it out here avoids walking its
  // word boxes. A page with no searchText at all cannot be ruled out, so it is
  // matched in full.
  const matchesNeedle = (searchText: string) =>
    !searchText || needles.some((needle) => searchText.includes(needle));

  const results: Array<{ documentId: string; highlights: unknown[] }> = [];
  for (const documentId of documentIds) {
    const document = getDocument(documentId);
    if (!document || document.ocrStatus === 'PENDING') continue;

    const automatic = pagesOf(documentId)
      .filter((page) => page.status === 'COMPLETE' && matchesNeedle(page.searchText))
      .flatMap((page) => findPageMatches(page, keywords, documentId));
    // Manual marks are the operator's own work and survive every re-search.
    results.push({ documentId, highlights: replaceAutoHighlights(documentId, automatic) });
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

/**
 * Builds the Excel report rows.
 *
 * Only the pages that actually carry a highlight are read. The report is
 * usually a few dozen findings out of a workspace of thousands of pages, so
 * fetching every page's word boxes to answer it -- which is what this used to
 * do -- was almost entirely wasted transfer.
 */
export async function buildStoredFindings(documentIds: string[]): Promise<ReportFinding[]> {
  const findings: ReportFinding[] = [];
  for (const documentId of documentIds) {
    const document = getDocument(documentId);
    if (!document) continue;
    const automatic = highlightsOf(documentId)
      .filter((highlight) => highlight.source === 'AUTO')
      .sort((a, b) => a.pageNumber - b.pageNumber || a.createdAt.getTime() - b.createdAt.getTime());
    if (!automatic.length) continue;

    const pageNumbers = new Set(automatic.map((highlight) => highlight.pageNumber));
    const pages = new Map(pagesOf(documentId)
      .filter((page) => pageNumbers.has(page.pageNumber))
      .map((page) => [page.pageNumber, { words: page.words as OcrWord[], text: page.text }]));

    for (const highlight of automatic) {
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

export { normalizeToken };
