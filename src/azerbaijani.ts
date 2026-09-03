import { expectedCentreGap, glyphWidth } from './glyphWidth.js';

/**
 * Putting back the letter the recogniser cannot see.
 *
 * PP-OCRv5's Latin model has no lowercase `ə` in its output layer. Every other
 * Azerbaijani letter is there -- `ı`, `İ`, `ğ`, `Ğ`, `ş`, `Ş`, `ç`, `Ç`, `ö`,
 * `Ö`, `ü`, `Ü` and even the uppercase `Ə` -- so this one gap is the whole
 * problem, and it is a bad one: schwa is among the most common letters in the
 * language. Measured on a rendered sample, `məktəb və təhsil` comes back as
 * `mktb v thsil`. That is not text with a typo in it, it is text nobody can
 * read, and it is what made extracted captions look like nonsense.
 *
 * The model does not guess when it meets one. It emits the CTC blank with high
 * confidence -- 0.68 to 0.70 on the sample, with no runner-up worth having --
 * so there is nothing to remap and no second choice to promote. What it does
 * leave behind is a hole: the characters either side are recognised, and the
 * distance between them is about one character wider than it should be.
 *
 * That hole is measurable, because the recogniser now reports where each
 * character sits (see `charOffsets`). On the same sample the gaps left by a
 * dropped schwa were 4 and 5 timesteps against 1 to 3 for ordinary letter
 * pairs, which is a clean separation. This fills those holes.
 *
 * It is deliberately narrow. Only text that asked for Azerbaijani is touched;
 * only gaps inside a word, between two letters, are considered; and the
 * threshold is measured against the line's own spacing rather than fixed, so a
 * bigger font or a wider face does not turn every gap into a schwa.
 */

/**
 * How much unexplained width counts as a dropped letter, in fractions of an em.
 *
 * The gap between two glyph centres is half of each glyph's own width, so what
 * a hole adds is the width of the character that went missing -- about 0.61 for
 * a schwa.
 *
 * Measured across rendered Azerbaijani and English samples once the widths
 * below became real metrics rather than three buckets, genuine holes ran 0.36
 * to 0.91 em and everything else stopped at 0.25. This sits in that gap. The
 * separation is what the accurate widths bought: with the earlier rough table
 * the same measurement gave 0.34 against 0.41, which left no room at all.
 */
const MISSING_WIDTH_THRESHOLD = 0.30;

/**
 * A schwa is a vowel, and Azerbaijani does not put two vowels together, so a
 * dropped one always leaves two consonants touching.
 *
 * This is the second half of the test and it does most of the work. Measured
 * across a rendered sample, every genuine hole had consonants on both sides,
 * while the widest false reading -- the `ui` of `quick`, at 0.371 em -- has a
 * vowel and is ruled out before its width is even considered. What remains on
 * the wrong side of the line tops out at 0.340 em against 0.409 for the
 * narrowest real hole, which is what the threshold above sits inside.
 */
// `y` is a consonant in Azerbaijani, so `yəni` is a word this has to repair.
const VOWELS = new Set([...'aeiouəıöüAEIOUƏIİÖÜ']);

/** Two dropped letters in a row is possible; more means the estimate is wrong. */
const MAX_INSERTED_PER_GAP = 2;

/**
 * The scale from em units to the recogniser's offsets, taken low.
 *
 * Holes are part of the sample and inflate the gaps they appear in, so a median
 * drifts upward on a word like `məktəb` where a third of the pairs are holes.
 * The 40th percentile stays with the pairs that have nothing missing.
 */
const SCALE_PERCENTILE = 0.4;

const isLetter = (character: string) => /\p{L}/u.test(character);
const isUpper = (character: string) => /\p{Lu}/u.test(character);

/**
 * What the model reaches for when it sees an uppercase `Ə`.
 *
 * U+2203 THERE EXISTS and U+2200 FOR ALL are the same shape turned about, and
 * both are in the charset while `Ə` is only sometimes recognised as itself --
 * `ƏDƏBİYYAT` came back as `∀DBiYYAT` and `ƏMƏK` as `∃MK`. No Azerbaijani text
 * contains a mathematical quantifier, so the substitution is free.
 */
const CONFUSED_UPPERCASE = /[∃∀]/g;

function percentile(sorted: number[], fraction: number) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
  return sorted[index]!;
}

export type SchwaRepair = { text: string; charOffsets: number[]; inserted: number };

/**
 * Restores the schwas dropped from one recognised line.
 *
 * `charOffsets` must line up with `text` one entry per character; when it does
 * not -- an older daemon, or a line the recogniser could not place -- the text
 * is returned with only the `∃` substitution applied, since that needs no
 * positions.
 */
export function restoreSchwa(text: string, charOffsets?: number[]): SchwaRepair {
  const corrected = text.replace(CONFUSED_UPPERCASE, 'Ə');
  if (!charOffsets || charOffsets.length !== corrected.length || corrected.length < 2) {
    return { text: corrected, charOffsets: charOffsets ?? [], inserted: 0 };
  }

  // Only gaps between two letters count, and each is judged against how wide
  // those two letters actually are. A gap next to a space or a comma is word or
  // punctuation spacing, which is wider for reasons of its own.
  type Pair = { index: number; gap: number; expected: number };
  const pairs: Pair[] = [];
  const candidates: Pair[] = [];
  for (let index = 0; index + 1 < corrected.length; index += 1) {
    const left = corrected[index]!;
    const right = corrected[index + 1]!;
    if (!isLetter(left) || !isLetter(right)) continue;
    const pair = {
      index,
      gap: charOffsets[index + 1]! - charOffsets[index]!,
      expected: expectedCentreGap(left, right),
    };
    // Every letter pair sets the scale, including the ones that cannot hold a
    // schwa -- the more of the line the estimate sees, the steadier it is.
    pairs.push(pair);
    // Only consonant pairs can be hiding one.
    if (!VOWELS.has(left) && !VOWELS.has(right)) candidates.push(pair);
  }
  if (pairs.length < 3 || !candidates.length) return { text: corrected, charOffsets, inserted: 0 };

  // One scale for the whole line: how many offset units an em is worth here.
  const scale = percentile(
    pairs.map((pair) => pair.gap / pair.expected).sort((a, b) => a - b),
    SCALE_PERCENTILE,
  );
  if (!(scale > 0)) return { text: corrected, charOffsets, inserted: 0 };

  const missingAt = new Map<number, number>();
  for (const pair of candidates) {
    // Whatever the two letters' own widths do not account for.
    const unexplained = pair.gap / scale - pair.expected;
    if (unexplained < MISSING_WIDTH_THRESHOLD) continue;
    // An uppercase schwa is wider than a lowercase one, so the hole it leaves
    // is bigger; dividing by the wrong one turns a single `Ə` into two.
    const schwaWidth = isUpper(corrected[pair.index]!) && isUpper(corrected[pair.index + 1]!)
      ? glyphWidth('Ə')
      : glyphWidth('ə');
    // Floor, not round: a hole measuring one and a half characters is one
    // character plus the error in these approximate widths, not two.
    const count = Math.min(MAX_INSERTED_PER_GAP, Math.max(1, Math.floor(unexplained / schwaWidth)));
    missingAt.set(pair.index, count);
  }
  if (!missingAt.size) return { text: corrected, charOffsets, inserted: 0 };

  const outText: string[] = [];
  const outOffsets: number[] = [];
  let inserted = 0;
  for (let index = 0; index < corrected.length; index += 1) {
    outText.push(corrected[index]!);
    outOffsets.push(charOffsets[index]!);
    const count = missingAt.get(index);
    if (!count) continue;
    const gap = charOffsets[index + 1]! - charOffsets[index]!;
    for (let step = 1; step <= count; step += 1) {
      // Uppercase only when both neighbours are, so `ƏMƏK` keeps its case and
      // `məktəb` does not acquire a capital in the middle.
      outText.push(isUpper(corrected[index]!) && isUpper(corrected[index + 1]!) ? 'Ə' : 'ə');
      outOffsets.push(charOffsets[index]! + (gap * step) / (count + 1));
      inserted += 1;
    }
  }
  return { text: outText.join(''), charOffsets: outOffsets, inserted };
}

/**
 * Undoes the breve-for-umlaut misreading.
 *
 * `ğ` and `ü` differ by the mark over the letter, and the recogniser confuses
 * the two: `mümkün` comes back as `mğmkğn`. The rest of the word is right, so
 * nothing else notices.
 *
 * A `ğ` wedged between two consonants is what gives it away. Azerbaijani builds
 * every syllable around a vowel, so that sequence cannot occur -- measured over
 * 151,712 words of the sample corpus it appears once, inside a word that was
 * itself garbled by a broken font, and no word at all lacks a vowel.
 *
 * The looser rule is not safe and was measured before being dropped: `ğ` after a
 * consonant is ordinary Azerbaijani, in `başlanğıcı`, `vurğulayıb`, `işğal` and
 * 374 more places in the same corpus. It is only the consonant on *both* sides
 * that is impossible.
 *
 * `ö` read as `ü` -- `ödəniş` as `üdəniş` -- is the same class of error and is
 * left alone, because both spellings are legal Azerbaijani in that position and
 * nothing in the writing system says which was meant.
 */
function repairBreveForUmlaut(text: string) {
  const characters = [...text];
  const isVowelOrBoundary = (character: string | undefined) =>
    character === undefined || !isLetter(character) || VOWELS.has(character);
  for (let index = 0; index < characters.length; index += 1) {
    if (characters[index] !== 'ğ' && characters[index] !== 'Ğ') continue;
    if (isVowelOrBoundary(characters[index - 1]) || isVowelOrBoundary(characters[index + 1])) continue;
    characters[index] = characters[index] === 'Ğ' ? 'Ü' : 'ü';
  }
  return characters.join('');
}

/**
 * Puts the vowel back into a word that lost the only one it had.
 *
 * A schwa at the edge of a word cannot be found by measuring: the recogniser
 * places a space where it likes, and the gap it leaves is no wider than the one
 * before an ordinary word. Measured on the sample, a real `və` read as `v` left
 * 0.430 em unexplained while the harmless space before `brown` left 0.391 -- no
 * threshold divides those.
 *
 * One case does not need measuring. No Azerbaijani word is written without a
 * vowel, so a lone lowercase consonant is always a word whose vowel went
 * missing, and the only vowel that goes missing is the schwa. That covers `və`
 * -- the commonest word in the language -- along with `də`, `nə` and `hə`.
 *
 * Lowercase only, and only a single letter. `Plan B` and `Vitamin C` are
 * uppercase, and a longer word that lost its final schwa (`ölkə` read as `ölk`)
 * still has vowels of its own, so neither is touched.
 */
const CONSONANT_WORD = /(^|[^\p{L}])(\p{Ll})(?=$|[^\p{L}])/gu;

export function restoreLoneConsonants(text: string) {
  return text.replace(CONSONANT_WORD, (match, before: string, letter: string) =>
    (VOWELS.has(letter) ? match : `${before}${letter}ə`));
}

/**
 * True when the caller asked for Azerbaijani.
 *
 * The repair is only correct for that language: the Latin model is shared with
 * English, Turkish and Uzbek, and none of those has a schwa to put back, so a
 * wide gap in an English line must be left as the wide gap it is.
 */
export function needsSchwaRepair(languages: string) {
  return /\baze?\b/i.test(languages) || languages.includes('aze');
}

/**
 * Applies the repair across a page's worth of recognised lines.
 *
 * Lines that need nothing are returned as they came in, so the common case --
 * a page with no Azerbaijani on it, or one the model read cleanly -- allocates
 * nothing.
 */
export function repairRecognizedLines<T extends { text: string; charOffsets?: number[] }>(
  lines: T[],
  languages: string,
): T[] {
  if (!needsSchwaRepair(languages)) return lines;
  return lines.map((line) => {
    const repaired = restoreSchwa(line.text, line.charOffsets);
    const text = restoreLoneConsonants(repairBreveForUmlaut(repaired.text));
    if (text === line.text) return line;
    // The offsets no longer line up once a lone consonant grows a letter, and
    // nothing downstream needs them after this point, so they are dropped
    // rather than left subtly wrong.
    return { ...line, text, charOffsets: text === repaired.text ? repaired.charOffsets : undefined };
  });
}
