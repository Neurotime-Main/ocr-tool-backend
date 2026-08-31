import { config } from './config.js';
import { resolveColumn, serverQuery } from './serverDb.js';

export type ServerKeyword = {
  id: number;
  text: string;
  projectIds: number[];
};

/**
 * The keywords offered for newspapers, with the projects each belongs to.
 *
 * `keyword_source_type` says which keywords apply to a source type;
 * `project_keyword` says which projects care about a keyword. Both are needed
 * before publishing, because a mention becomes one `media_results` row per
 * project -- so they are fetched together rather than leaving the UI holding
 * keywords whose projects are only discovered at export time.
 *
 * A keyword with no project is still offered for searching. It simply produces
 * no rows on publish, and `publish` reports it as skipped rather than failing
 * the whole export.
 */
export async function fetchNewsKeywords(): Promise<ServerKeyword[]> {
  const textColumn = await resolveColumn('keyword', ['name', 'keyword', 'title', 'value', 'text', 'word'], 'keyword text');

  // The column name is resolved from information_schema above, so it is one of
  // the fixed candidates rather than anything a caller supplied.
  const rows = await serverQuery<{ id: number; text: string | null }>(
    `SELECT k.id AS id, k."${textColumn}" AS text
       FROM keyword_source_type kst
       JOIN keyword k ON k.id = kst.keyword_id
      WHERE kst.source_type_id = $1
      ORDER BY k."${textColumn}" ASC`,
    [config.newsSourceTypeId],
  );

  const keywords = rows
    .filter((row) => row.text && row.text.trim())
    .map((row) => ({ id: Number(row.id), text: row.text!.trim(), projectIds: [] as number[] }));
  if (!keywords.length) return [];

  const links = await serverQuery<{ keyword_id: number; project_id: number }>(
    `SELECT keyword_id, project_id FROM project_keyword WHERE keyword_id = ANY($1::int[])`,
    [keywords.map((keyword) => keyword.id)],
  );
  const byKeyword = new Map<number, number[]>();
  for (const link of links) {
    const list = byKeyword.get(Number(link.keyword_id)) ?? [];
    list.push(Number(link.project_id));
    byKeyword.set(Number(link.keyword_id), list);
  }
  for (const keyword of keywords) keyword.projectIds = byKeyword.get(keyword.id) ?? [];

  // De-duplicate by text: the same word can be registered more than once, and
  // searching for it twice would highlight and publish it twice.
  const seen = new Map<string, ServerKeyword>();
  for (const keyword of keywords) {
    const key = keyword.text.toLocaleLowerCase();
    const existing = seen.get(key);
    if (!existing) { seen.set(key, keyword); continue; }
    // Keep one entry, but carry every project the duplicates point at.
    existing.projectIds = [...new Set([...existing.projectIds, ...keyword.projectIds])];
  }
  return [...seen.values()];
}
