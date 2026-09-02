/**
 * Roughly how wide a character is, relative to the others around it.
 *
 * Two places need this and neither can get the real thing. `pdfText` divides a
 * text run that holds several words and has no glyph metrics, because pdf.js
 * does not expose them through `getTextContent`. `azerbaijani` has to tell a
 * gap left by a dropped letter from the ordinary gap either side of a wide one,
 * and the recogniser reports positions but not widths.
 *
 * These are approximate advance widths for a proportional face, in fractions of
 * an em. They are not any document's real metrics. Being approximately right
 * about every character beats being exactly wrong about all of them, which is
 * what treating `i` and `W` as equals amounts to.
 */

/**
 * Advance widths in fractions of an em, taken from a normal-width sans face.
 *
 * The first version of this sorted characters into three buckets -- narrow,
 * wide, and everything else at 0.52 -- which was enough to stop treating `i`
 * like `W` but not enough for the job in `azerbaijani`, where what matters is
 * whether a gap is one character wider than it should be. `l` really is 0.28
 * and `t` 0.39, so calling both 0.52 hid a whole missing letter inside the
 * error: `dövlət` read as `dövlt` and `məktəblər` as `məktblər` went uncaught.
 *
 * Real faces differ from these by a few percent and from each other by more,
 * which is why callers fit a scale to the line in front of them rather than
 * trusting the absolute numbers.
 */
const WIDTHS: Record<string, number> = {
  ' ': 0.32,
  a: 0.61, b: 0.64, c: 0.55, d: 0.64, e: 0.61, f: 0.35, g: 0.64, h: 0.63,
  i: 0.28, j: 0.28, k: 0.58, l: 0.28, m: 0.97, n: 0.63, o: 0.61, p: 0.64,
  q: 0.64, r: 0.41, s: 0.52, t: 0.39, u: 0.63, v: 0.59, w: 0.82, x: 0.59,
  y: 0.59, z: 0.52,
  A: 0.68, B: 0.69, C: 0.70, D: 0.77, E: 0.63, F: 0.58, G: 0.78, H: 0.75,
  I: 0.29, J: 0.29, K: 0.67, L: 0.56, M: 0.86, N: 0.75, O: 0.79, P: 0.60,
  Q: 0.79, R: 0.70, S: 0.65, T: 0.61, U: 0.73, V: 0.68, W: 0.99, X: 0.68,
  Y: 0.61, Z: 0.61,
  // Azerbaijani and Turkish letters, sized from their base forms.
  'ə': 0.61, 'Ə': 0.63, 'ı': 0.28, 'İ': 0.29, 'ğ': 0.64, 'Ğ': 0.78,
  'ş': 0.52, 'Ş': 0.65, 'ç': 0.55, 'Ç': 0.70, 'ö': 0.61, 'Ö': 0.79,
  'ü': 0.63, 'Ü': 0.73,
  // Punctuation, which sits between words often enough to matter.
  '.': 0.32, ',': 0.32, ';': 0.34, ':': 0.34, '!': 0.36, '?': 0.52,
  "'": 0.27, '"': 0.42, '`': 0.50, '-': 0.36, '(': 0.39, ')': 0.39,
  '[': 0.39, ']': 0.39, '{': 0.40, '}': 0.40, '/': 0.34, '\\': 0.34,
  '@': 1.00, '%': 0.98, '#': 0.64, '&': 0.73,
};

/** A typical lowercase letter, and what a missing one is assumed to cost. */
export const AVERAGE_GLYPH_WIDTH = 0.61;

export function glyphWidth(character: string) {
  const known = WIDTHS[character];
  if (known !== undefined) return known;
  if (character >= '0' && character <= '9') return 0.64;
  // Cyrillic and anything else the table does not name: uppercase letters run
  // wider than lowercase in every script here, which is the distinction worth
  // keeping when the exact figure is unavailable.
  if (/\p{Lu}/u.test(character)) return 0.70;
  return AVERAGE_GLYPH_WIDTH;
}

/**
 * Cumulative width up to each index, so a slice of a run can be measured.
 *
 * Indexed by UTF-16 unit, matching what `matchAll` reports, so a surrogate pair
 * is charged as two halves rather than shifting every later position.
 */
export function widthPrefix(text: string) {
  const prefix = new Float64Array(text.length + 1);
  for (let index = 0; index < text.length; index += 1) {
    prefix[index + 1] = prefix[index]! + glyphWidth(text[index]!);
  }
  return prefix;
}

/**
 * The distance between the centres of two adjacent glyphs.
 *
 * Half of each, since a centre sits in the middle of its own advance. This is
 * what a gap should measure when nothing was dropped between them.
 */
export function expectedCentreGap(left: string, right: string) {
  return (glyphWidth(left) + glyphWidth(right)) / 2;
}
