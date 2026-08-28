const mojibakeReplacements: ReadonlyArray<readonly [string, string]> = [
  ['É™', 'ə'], ['Æ', 'Ə'], ['Ä±', 'ı'], ['Ä°', 'İ'],
  ['ÄŸ', 'ğ'], ['Äž', 'Ğ'], ['ÅŸ', 'ş'], ['Åž', 'Ş'],
  ['Ã§', 'ç'], ['Ã‡', 'Ç'], ['Ã¶', 'ö'], ['Ã–', 'Ö'],
  ['Ã¼', 'ü'], ['Ãœ', 'Ü'],
];

// A common legacy Azerbaijani PDF font maps its glyphs through the 0xC0–0xFF
// range. PDF.js then exposes those byte values as characters such as `òè`.
// This table converts that legacy font encoding to modern Azerbaijani Latin.
const legacyAzeriBytes: Readonly<Record<number, string>> = {
  0xC0: 'A', 0xC1: 'B', 0xC2: 'V', 0xC3: 'Q', 0xC4: 'D', 0xC5: 'E', 0xC6: 'J', 0xC7: 'Z',
  0xC8: 'İ', 0xC9: 'Y', 0xCA: 'K', 0xCB: 'L', 0xCC: 'M', 0xCD: 'N', 0xCE: 'O', 0xCF: 'P',
  0xD0: 'R', 0xD1: 'S', 0xD2: 'T', 0xD3: 'U', 0xD4: 'F', 0xD5: 'X', 0xD7: 'Ç', 0xD8: 'Ş',
  0xD9: 'H', 0xDA: 'C', 0xDB: 'I', 0xDC: 'Ğ', 0xDD: 'G', 0xDE: 'Ö', 0xDF: 'Ə',
  0xE0: 'a', 0xE1: 'b', 0xE2: 'v', 0xE3: 'q', 0xE4: 'd', 0xE5: 'e', 0xE6: 'j', 0xE7: 'z',
  0xE8: 'i', 0xE9: 'y', 0xEA: 'k', 0xEB: 'l', 0xEC: 'm', 0xED: 'n', 0xEE: 'o', 0xEF: 'p',
  0xF0: 'r', 0xF1: 's', 0xF2: 't', 0xF3: 'u', 0xF4: 'f', 0xF5: 'x', 0xF6: 'ü', 0xF7: 'ç',
  0xF8: 'ş', 0xF9: 'h', 0xFA: 'c', 0xFB: 'ı', 0xFC: 'ğ', 0xFD: 'g', 0xFE: 'ö', 0xFF: 'ə',
};

// A second legacy Azerbaijani font family maps its glyphs through Cyrillic
// code points instead of the 0xC0-0xFF range above. PDF.js surfaces those
// bytes as real Cyrillic letters, so `ийул` is the word `iyul` drawn with a
// font whose `и` glyph is a Latin `i`. Mastheads and date lines in the same
// documents use it alongside the byte-range font.
const legacyAzeriCyrillic: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'q', ғ: 'ğ', д: 'd', е: 'e', ә: 'ə', я: 'ə',
  ж: 'j', з: 'z', и: 'i', ы: 'ı', й: 'y', к: 'k', ҝ: 'g', л: 'l', м: 'm',
  н: 'n', о: 'o', ө: 'ö', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ү: 'ü',
  ф: 'f', х: 'x', һ: 'h', ч: 'ç', ҹ: 'c', ш: 'ş', ъ: 'ə', э: 'e', ю: 'yu',
  А: 'A', Б: 'B', В: 'V', Г: 'Q', Ғ: 'Ğ', Д: 'D', Е: 'E', Ә: 'Ə', Я: 'Ə',
  Ж: 'J', З: 'Z', И: 'I', Ы: 'I', Й: 'Y', К: 'K', Ҝ: 'G', Л: 'L', М: 'M',
  Н: 'N', О: 'O', Ө: 'Ö', П: 'P', Р: 'R', С: 'S', Т: 'T', У: 'U', Ү: 'Ü',
  Ф: 'F', Х: 'X', Һ: 'H', Ч: 'Ç', Ҹ: 'C', Ш: 'Ş', Ъ: 'Ə', Э: 'E', Ю: 'Yu',
};

const isCyrillic = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return code >= 0x400 && code <= 0x4FF;
};

/**
 * True when a run of Cyrillic code points is really Latin Azerbaijani drawn
 * with a Cyrillic-encoded font. Genuine Russian text is left alone, because it
 * leans on letters this Azerbaijani font never uses (`ё`, `щ`, `ъ` as a sign,
 * `ы` after consonants only) and is far longer than a masthead line.
 */
export function hasLegacyAzeriCyrillicEncoding(text: string) {
  const cyrillic = [...text].filter(isCyrillic);
  if (cyrillic.length < 3) return false;
  const mappable = cyrillic.filter((character) => legacyAzeriCyrillic[character] != null).length;
  return mappable / cyrillic.length >= 0.9;
}

export function hasLegacyAzeriFontEncoding(text: string) {
  const nonWhitespace = [...text].filter((character) => !/\s/u.test(character));
  const legacyCharacters = nonWhitespace.filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0xC0 && code <= 0xFF && legacyAzeriBytes[code] != null;
  }).length;
  // Proper Azerbaijani text normally has only a few non-ASCII characters;
  // malformed legacy-font text is dominated by this byte range.
  return legacyCharacters >= 3 && legacyCharacters / Math.max(1, nonWhitespace.length) >= 0.12;
}

export type LegacyEncodings = { bytes: boolean; cyrillic: boolean };

/**
 * Works out which legacy font encodings a run of text is using.
 *
 * Detection needs a whole page, not a word. Both tests are ratios over a body
 * of text, and the documents that use these fonts are typeset in justified
 * columns broken across syllables, so a large share of their "words" are two
 * characters long -- far too little to tell a broken code page from ordinary
 * accented Latin. Callers therefore detect once and map many times.
 */
export function detectLegacyEncodings(text: string): LegacyEncodings {
  const bytes = hasLegacyAzeriFontEncoding(text);
  return {
    bytes,
    // A document drawn with the byte-range font uses the Cyrillic-mapped one
    // for its masthead and dates, where there is rarely enough text to detect
    // it on its own. Finding either is good enough reason to decode both.
    cyrillic: bytes || hasLegacyAzeriCyrillicEncoding(text),
  };
}

/** Applies the chosen legacy maps to one fragment, without re-detecting. */
export function applyLegacyEncodings(text: string, encodings: LegacyEncodings) {
  let repaired = text;
  if (encodings.bytes) {
    repaired = [...repaired].map((character) => legacyAzeriBytes[character.codePointAt(0) ?? -1] ?? character).join('');
  }
  if (encodings.cyrillic) {
    repaired = [...repaired].map((character) => legacyAzeriCyrillic[character] ?? character).join('');
  }
  return repaired;
}

function repairLegacyAzeriFont(text: string) {
  return applyLegacyEncodings(text, detectLegacyEncodings(text));
}

/**
 * Decodes both legacy Azerbaijani font encodings into real Unicode. The
 * extraction path calls this before deciding whether a page needs OCR: these
 * PDFs carry a complete, correctly positioned text layer that only looks like
 * mojibake, and reading it is several hundred times cheaper than recognising a
 * rasterised copy of the same page.
 */
export function repairLegacyEncodings(text: string) {
  return repairLegacyAzeriFont(text);
}

/** True when either legacy font encoding is present. */
export function hasLegacyEncoding(text: string) {
  const { bytes, cyrillic } = detectLegacyEncodings(text);
  return bytes || cyrillic;
}

/** Keep valid Unicode (including Azerbaijani) while removing characters that
 * cannot be safely represented in an XLSX cell. */
export function cleanReportText(value: string, maxLength = 4000) {
  let text = repairLegacyAzeriFont(value.normalize('NFC'));
  for (const [broken, repaired] of mojibakeReplacements) text = text.replaceAll(broken, repaired);
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\uFFFD]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Excel treats leading =, +, -, and @ as formulas. Preserve the visible
 * source text while forcing these values to remain plain text. */
export function spreadsheetText(value: string, maxLength = 4000) {
  const cleaned = cleanReportText(value, maxLength);
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
}
