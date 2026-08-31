/**
 * Read-only report on the Neurotime database's shape.
 *
 * Run with `npm run inspect:server-db`. It issues nothing but SELECTs against
 * `information_schema` plus a handful of counts, so it is safe to run against
 * production at any time.
 *
 * It exists because this service was written from a description of those tables
 * rather than from the schema, and a guess about a column name is the kind of
 * mistake that is invisible until it inserts wrong data. Run this once and the
 * output either confirms the assumptions below or names exactly what differs.
 */
import { config } from './config.js';
import { checkServerDb, closeServerDb, listColumns, serverQuery } from './serverDb.js';

const TABLES = ['keyword', 'keyword_source_type', 'project_keyword', 'media_results', 'media_result_keywords'] as const;

/** What the publishing code expects to find, and where it looks. */
const EXPECTATIONS: Record<string, Array<{ purpose: string; candidates: string[] }>> = {
  keyword: [
    { purpose: 'primary key', candidates: ['id'] },
    { purpose: 'keyword text', candidates: ['name', 'keyword', 'title', 'value', 'text', 'word'] },
  ],
  keyword_source_type: [
    { purpose: 'keyword reference', candidates: ['keyword_id'] },
    { purpose: 'source type reference', candidates: ['source_type_id'] },
  ],
  project_keyword: [
    { purpose: 'keyword reference', candidates: ['keyword_id'] },
    { purpose: 'project reference', candidates: ['project_id'] },
  ],
  // A link row, not a copy of the article: which keyword and project a result
  // belongs to, and nothing else.
  media_result_keywords: [
    { purpose: 'keyword', candidates: ['keyword_id'] },
    { purpose: 'keyword name', candidates: ['keyword_name'] },
    { purpose: 'source type', candidates: ['source_type', 'source_type_id'] },
    { purpose: 'project', candidates: ['project_id'] },
    { purpose: 'result number', candidates: ['result_id'] },
    { purpose: 'score', candidates: ['score'] },
    { purpose: 'active flag', candidates: ['active'] },
    { purpose: 'created at', candidates: ['created_at'] },
  ],
  media_results: [
    { purpose: 'source type', candidates: ['source_type', 'source_type_id'] },
    { purpose: 'project', candidates: ['project_id'] },
    { purpose: 'result number', candidates: ['result_id'] },
    { purpose: 'author', candidates: ['author'] },
    { purpose: 'date', candidates: ['date'] },
    { purpose: 'title', candidates: ['title'] },
    { purpose: 'content', candidates: ['content'] },
    { purpose: 'url', candidates: ['url'] },
    { purpose: 'status', candidates: ['status'] },
    { purpose: 'created at', candidates: ['created_at'] },
  ],
};

const connection = await checkServerDb();
console.log(`connection: ${connection.ok ? 'ok' : 'FAILED'} - ${connection.detail}\n`);
if (!connection.ok) {
  await closeServerDb();
  process.exit(1);
}

let problems = 0;

for (const table of TABLES) {
  const columns = await listColumns(table);
  if (!columns.length) {
    console.log(`TABLE ${table}: NOT FOUND\n`);
    problems += 1;
    continue;
  }
  console.log(`TABLE ${table}`);
  for (const column of columns) {
    console.log(
      `    ${column.column_name.padEnd(22)} ${column.data_type.padEnd(28)}`
      + `${column.is_nullable === 'YES' ? 'null' : 'NOT NULL'}`
      + `${column.column_default ? `  default ${column.column_default}` : ''}`,
    );
  }
  const present = new Set(columns.map((column) => column.column_name));
  for (const { purpose, candidates } of EXPECTATIONS[table] ?? []) {
    const found = candidates.find((candidate) => present.has(candidate));
    if (found) {
      if (found !== candidates[0]) console.log(`  note: ${purpose} resolved to "${found}" (not "${candidates[0]}")`);
    } else {
      console.log(`  MISSING: no ${purpose} column; looked for ${candidates.join(', ')}`);
      problems += 1;
    }
  }
  console.log('');
}

// A few counts, so the numbers the app will work with are visible up front.
const [{ count: keywordCount } = { count: '0' }] = await serverQuery<{ count: string }>(
  `SELECT COUNT(*)::text AS count FROM keyword_source_type WHERE source_type_id = $1`,
  [config.newsSourceTypeId],
);
console.log(`keywords for source_type_id=${config.newsSourceTypeId}: ${keywordCount}`);

const [{ max: maxResultId } = { max: null }] = await serverQuery<{ max: string | null }>(
  'SELECT MAX(result_id)::text AS max FROM media_results',
);
console.log(`media_results: current MAX(result_id) = ${maxResultId ?? '(none)'}`);

const [{ count: resultCount } = { count: '0' }] = await serverQuery<{ count: string }>(
  'SELECT COUNT(*)::text AS count FROM media_results',
);
console.log(`media_results: ${resultCount} existing rows`);

// The `date` column's type decides whether a dd.mm.yyyy string can be sent as
// text or has to be converted first.
const dateColumn = (await listColumns('media_results')).find((column) => column.column_name === 'date');
if (dateColumn) {
  console.log(`\nmedia_results.date is ${dateColumn.data_type}`);
  console.log(dateColumn.data_type.includes('char') || dateColumn.data_type === 'text'
    ? '  -> stored as text; the dd.mm.yyyy string is written as-is.'
    : '  -> a real date/timestamp; the parsed date is written, not the dd.mm.yyyy string.');
}

console.log(problems ? `\n${problems} mismatch(es) found - publishing would fail until these are resolved.` : '\nSchema matches what the publisher expects.');
await closeServerDb();
process.exit(problems ? 1 : 0);
