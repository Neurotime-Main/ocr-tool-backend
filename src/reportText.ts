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

function repairLegacyAzeriFont(text: string) {
  if (!hasLegacyAzeriFontEncoding(text)) return text;
  return [...text].map((character) => legacyAzeriBytes[character.codePointAt(0) ?? -1] ?? character).join('');
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
