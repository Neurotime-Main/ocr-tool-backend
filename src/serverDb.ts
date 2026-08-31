import pg from 'pg';
import { config } from './config.js';

/**
 * The Neurotime production database (`media_analyse`).
 *
 * This is a live system that other things depend on, and this service is a
 * guest in it: it reads keywords and projects, and it appends rows to
 * `media_results`. It must never change or remove anything that is already
 * there.
 *
 * That rule is enforced here rather than left to reviewers noticing. Every
 * statement passes `assertReadOrAppend`, which rejects anything that is not a
 * SELECT or an INSERT before it reaches the wire, so an UPDATE or DELETE
 * introduced later fails immediately and loudly instead of quietly modifying
 * production data.
 *
 * The pool is created on first use, so a deployment without these credentials
 * boots normally and only the keyword and publish features are unavailable.
 */

let pool: pg.Pool | undefined;

export class ServerDbUnavailableError extends Error {}

export function serverDbConfigured() {
  return Boolean(config.serverDb.host && config.serverDb.database && config.serverDb.user);
}

function getPool() {
  if (!serverDbConfigured()) {
    throw new ServerDbUnavailableError(
      'The Neurotime database is not configured. Set SERVER_DB_HOST, SERVER_DB_PORT, SERVER_DB_USER, '
      + 'SERVER_DB_PASSWORD and SERVER_DB_NAME to enable keywords and publishing.',
    );
  }
  pool ??= new pg.Pool({
    host: config.serverDb.host,
    port: config.serverDb.port,
    user: config.serverDb.user,
    password: config.serverDb.password,
    database: config.serverDb.database,
    ssl: config.serverDb.ssl ? { rejectUnauthorized: false } : false,
    // Small: this database belongs to other services too, and nothing here is
    // latency critical enough to justify holding many of its connections.
    max: config.serverDb.poolSize,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'markwise-ocr',
  });
  return pool;
}

const FORBIDDEN = /\b(update|delete|drop|truncate|alter|create|grant|revoke|merge|replace)\b/i;

/**
 * Refuses any statement that could change existing data.
 *
 * Comments are stripped first so that a keyword hidden inside one cannot be
 * used to smuggle a statement past the check, and only a leading SELECT, WITH
 * or INSERT is allowed through at all.
 */
function assertReadOrAppend(sql: string) {
  const stripped = sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
  if (!/^(select|with|insert)\b/i.test(stripped)) {
    throw new Error(`Refused: only SELECT and INSERT are permitted against the Neurotime database. Got: ${stripped.slice(0, 60)}`);
  }
  // `returning` is fine on an INSERT; the words below never are.
  if (FORBIDDEN.test(stripped)) {
    throw new Error(`Refused: this statement would modify existing rows in the Neurotime database: ${stripped.slice(0, 80)}`);
  }
}

export async function serverQuery<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<Row[]> {
  assertReadOrAppend(sql);
  const result = await getPool().query<Row>(sql, params);
  return result.rows;
}

/**
 * Runs several statements as one transaction.
 *
 * Publishing a document inserts a row per project per mention; either all of
 * them land or none do, so a failure part-way through does not leave a document
 * half-published with no way to tell which half.
 */
export async function serverTransaction<T>(
  work: (query: <Row extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]) => Promise<Row[]>) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(async (sql, params = []) => {
      assertReadOrAppend(sql);
      return (await client.query(sql, params)).rows;
    });
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function checkServerDb(): Promise<{ ok: boolean; detail: string }> {
  if (!serverDbConfigured()) {
    return { ok: false, detail: 'not configured (SERVER_DB_* unset)' };
  }
  try {
    const rows = await serverQuery<{ db: string }>('SELECT current_database() AS db');
    return { ok: true, detail: `${config.serverDb.host}/${rows[0]?.db ?? config.serverDb.database}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message.split('\n')[0] ?? 'unreachable' };
  }
}

export async function closeServerDb() {
  await pool?.end().catch(() => undefined);
  pool = undefined;
}

/**
 * Finds which column of a table holds a given kind of value.
 *
 * The tables here belong to another team and this service was written against a
 * description of them rather than the schema itself, so rather than hard-coding
 * a guess that fails at run time with a bare "column does not exist", the
 * candidates are looked up once in `information_schema` and the first one that
 * actually exists is used. `describeServerSchema` reports what was resolved.
 */
const resolvedColumns = new Map<string, string>();

export async function resolveColumn(table: string, candidates: string[], purpose: string) {
  const cacheKey = `${table}:${purpose}`;
  const cached = resolvedColumns.get(cacheKey);
  if (cached) return cached;

  const rows = await serverQuery<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table],
  );
  if (!rows.length) {
    throw new Error(`Table "${table}" was not found in the Neurotime database. Run \`npm run inspect:server-db\` to see what is there.`);
  }
  const present = new Set(rows.map((row) => row.column_name));
  const found = candidates.find((candidate) => present.has(candidate));
  if (!found) {
    throw new Error(
      `Could not find the ${purpose} column on "${table}". Looked for ${candidates.join(', ')}; `
      + `the table has ${[...present].join(', ')}.`,
    );
  }
  resolvedColumns.set(cacheKey, found);
  return found;
}

/**
 * Whether a column stores a real date/timestamp or plain text.
 *
 * `media_results.date` holds an issue date written `24.07.2026`. If the column
 * is text that string is stored verbatim; if it is a date column, Postgres
 * parses it under the server's DateStyle -- which by default is MDY, reads 24
 * as a month, and rejects the row with "date/time field value out of range".
 * The two cases need different values, so the type is looked up rather than
 * assumed, and cached for the life of the process.
 */
const columnTypes = new Map<string, string | null>();

export async function resolveColumnType(table: string, column: string) {
  const cacheKey = `${table}.${column}`;
  if (columnTypes.has(cacheKey)) return columnTypes.get(cacheKey) ?? null;
  const rows = await serverQuery<{ data_type: string }>(
    'SELECT data_type FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
    [table, column],
  );
  const type = rows[0]?.data_type ?? null;
  columnTypes.set(cacheKey, type);
  return type;
}

/** True for text-like types, where a formatted string is stored as written. */
export function isTextualType(dataType: string | null) {
  if (!dataType) return false;
  return dataType.includes('char') || dataType === 'text' || dataType === 'citext';
}

/**
 * Builds an INSERT from the columns a table actually has.
 *
 * These tables belong to another team and are not identical to each other:
 * `media_results` carries the article itself, while `media_result_keywords` is
 * a link row holding only ids. Writing a fixed column list for each meant
 * guessing, and a wrong guess fails the whole publish with
 * `column "author" of relation ... does not exist` after every image has
 * already been uploaded.
 *
 * So the caller supplies every value it *could* write, and whatever the table
 * has no column for is dropped. A column the table requires but the caller
 * never offers still fails loudly, which is the right outcome -- silence there
 * would mean writing rows that are quietly incomplete.
 */
export async function buildInsert(table: string, values: Record<string, unknown>) {
  const columns = await listColumns(table);
  if (!columns.length) {
    throw new Error(`Table "${table}" was not found in the Neurotime database. Run \`npm run inspect:server-db\`.`);
  }
  const present = new Set(columns.map((column) => column.column_name));
  const used = Object.keys(values).filter((column) => present.has(column));
  if (!used.length) {
    throw new Error(
      `None of the values offered for "${table}" match its columns. `
      + `Offered ${Object.keys(values).join(', ')}; the table has ${[...present].join(', ')}.`,
    );
  }
  const placeholders = used.map((_column, index) => `$${index + 1}`);
  return {
    sql: `INSERT INTO ${table} (${used.map((column) => `"${column}"`).join(', ')}) VALUES (${placeholders.join(', ')})`,
    columns: used,
    /** Parameters for another row of the same shape, in the statement's order. */
    paramsFor: (row: Record<string, unknown>) => used.map((column) => row[column]),
    /** Values the table had no column for; reported by the publish result. */
    ignored: Object.keys(values).filter((column) => !present.has(column)),
  };
}

export async function listColumns(table: string) {
  return serverQuery<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
}
