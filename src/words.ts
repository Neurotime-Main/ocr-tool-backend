import type { OcrWord } from './types.js';

/**
 * Shrinks the word boxes before they are stored.
 *
 * `words` is the largest column in the database and the one a keyword search
 * spends most of its time transferring: a broadsheet page carries five thousand
 * of them. As produced they cost about 210 bytes each, most of it accidental --
 * coordinates serialised to sixteen significant digits, a confidence with six
 * decimal places, and identifiers long enough to be globally unique when they
 * only ever have to be unique within their page.
 *
 * Rounding to five decimals leaves positions accurate to well under a tenth of
 * a millimetre on A4, far finer than a highlight rectangle needs, and `blockId`
 * is dropped because nothing has ever read it. Together that halves the column,
 * and so halves the time a search over many matching pages takes.
 */
export function compactWords(words: OcrWord[]): OcrWord[] {
  const round = (value: number) => Math.round(value * 1e5) / 1e5;
  const lineIds = new Map<string, string>();
  return words.map((word, index) => {
    let lineId: string | undefined;
    if (word.lineId !== undefined) {
      lineId = lineIds.get(word.lineId);
      if (lineId === undefined) {
        lineId = `l${lineIds.size}`;
        lineIds.set(word.lineId, lineId);
      }
    }
    return {
      id: `w${index}`,
      text: word.text,
      confidence: Math.round(word.confidence),
      x: round(word.x),
      y: round(word.y),
      width: round(word.width),
      height: round(word.height),
      ...(lineId === undefined ? {} : { lineId }),
    };
  });
}

/**
 * True when a stored page still carries the original, uncompacted word shape.
 *
 * Recognised by the fields compaction removes: the unused `blockId`, and
 * coordinates that were never rounded. Checking one word is enough, because a
 * page is always written whole.
 */
export function needsCompaction(words: unknown): words is OcrWord[] {
  if (!Array.isArray(words) || !words.length) return false;
  const [first] = words as OcrWord[];
  if (!first) return false;
  return first.blockId !== undefined || Math.round(first.x * 1e5) / 1e5 !== first.x;
}
