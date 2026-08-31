/**
 * Reads the newspaper and its issue date out of an uploaded file's name.
 *
 * The agreed convention is `<newspaper title>_<dd.mm.yyyy>.pdf`, so the split is
 * on the *last* underscore -- titles routinely contain underscores of their own,
 * and only the trailing field is a date.
 *
 * Nothing here throws. A name that does not follow the convention still
 * publishes: the whole stem becomes the author and the date falls back to today,
 * with `dateFromFileName` false so the caller can warn. Refusing the upload
 * instead would mean a mis-typed filename loses the OCR work already done.
 */

export type ParsedFileName = {
  /** The newspaper, used as `media_results.author`. */
  author: string;
  /** Issue date as written, `dd.mm.yyyy`. */
  dateText: string;
  /** The same date parsed, for a real date column. */
  date: Date;
  /** False when the name carried no usable date and today was substituted. */
  dateFromFileName: boolean;
};

const DATE_PATTERN = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/;

const pad = (value: number) => String(value).padStart(2, '0');

export function formatDate(date: Date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * `YYYY-MM-DD`, for writing into a real date column.
 *
 * Sent as a string rather than a `Date` on purpose. A `Date` carries a time and
 * an offset, so a value built at local midnight can land on the previous day
 * once the database applies its own time zone -- and an issue dated the 24th
 * filed under the 23rd is the kind of error nobody notices. A bare date has no
 * such ambiguity, and Postgres reads this form identically under every
 * DateStyle setting.
 */
export function formatIsoDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Parses `dd.mm.yyyy`, rejecting dates that do not exist.
 *
 * `new Date(2026, 1, 31)` silently rolls over to 3 March, so the components are
 * compared back against the result: a typo becomes a fallback rather than a
 * plausible-looking wrong date in a published row.
 */
function parseDayFirst(value: string) {
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)) return null;
  return date;
}

export function parseFileName(originalName: string, now = new Date()): ParsedFileName {
  const stem = originalName.replace(/\.[^.]+$/, '').trim();
  const separator = stem.lastIndexOf('_');

  if (separator > 0) {
    const candidate = stem.slice(separator + 1);
    const date = parseDayFirst(candidate);
    if (date) {
      const author = stem.slice(0, separator).replace(/[_\s]+/g, ' ').trim();
      return {
        author: author || stem,
        dateText: formatDate(date),
        date,
        dateFromFileName: true,
      };
    }
  }

  // Some issues are named with the date first, or with no separator at all.
  // A date anywhere in the name is better than today's.
  const loose = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/.exec(stem);
  if (loose) {
    const date = parseDayFirst(loose[0]);
    if (date) {
      const author = stem.replace(loose[0], '').replace(/[_\s.\-]+/g, ' ').trim();
      return {
        author: author || stem,
        dateText: formatDate(date),
        date,
        dateFromFileName: true,
      };
    }
  }

  return {
    author: stem.replace(/[_\s]+/g, ' ').trim() || 'Unknown',
    dateText: formatDate(now),
    date: now,
    dateFromFileName: false,
  };
}

/** A filename-safe, URL-safe form of a string, for building image keys. */
export function slugify(value: string, maxLength = 60) {
  const slug = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ə/gi, 'e')
    .replace(/ı/g, 'i')
    .replace(/ğ/gi, 'g')
    .replace(/ş/gi, 's')
    .replace(/ç/gi, 'c')
    .replace(/ö/gi, 'o')
    .replace(/ü/gi, 'u')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
  return slug || 'item';
}
