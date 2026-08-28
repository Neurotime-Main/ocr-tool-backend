/**
 * The single definition of "the same text" for keyword matching.
 *
 * Both sides of a search go through this: the query the user types, and the
 * `searchText` column written when a page is stored. They have to agree
 * exactly, so there is one implementation rather than one per call site.
 */

/**
 * `ə` is dropped rather than folded to `e`.
 *
 * PP-OCRv5's Latin recognition model has no lowercase `ə` in its character
 * set -- an upstream gap, with `Ə` present but not its lowercase form -- so it
 * writes `Azrbaycan` where the page reads `Azərbaycan`. Removing the letter
 * from the query as well makes the two agree, and it keeps working for pages
 * whose text layer spells the word correctly, since those lose the same letter.
 * Folding to `e` instead would leave a typed `Azərbaycan` unable to match any
 * recognised page.
 */
export function normalizeToken(value: string) {
  return value
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .replace(/ə/g, '')
    .replace(/(^[^\p{L}\p{N}\p{Pd}]+|[^\p{L}\p{N}\p{Pd}]+$)/gu, '');
}

/**
 * The comparison form of a run of text: normalised, then stripped of
 * everything that is not a letter or a digit.
 *
 * Removing the spaces is what lets a keyword survive the way these documents
 * are typeset. Justified newspaper columns break words across syllables
 * (`şə bə kə lər dən`), and PDF text layers split a single word into several
 * glyph runs, so a word-by-word comparison misses matches a reader can see
 * plainly. Comparing the letters alone finds them; the caller keeps the word
 * boundaries separately and uses them to reject matches that would otherwise
 * start or end mid-word.
 */
export function normalizeForSearch(value: string) {
  return normalizeToken(value).replace(/[^\p{L}\p{N}]/gu, '');
}
