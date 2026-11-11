import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, types } from 'pg';
import { config } from './config.js';

/** bigint/numeric -> number (значения у нас в пределах safe integer). */
types.setTypeParser(20, (v) => Number(v));
types.setTypeParser(1700, (v) => Number(v));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => console.error('[db] pool error', err));

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params as any[]);
  return res.rows as T[];
}

export async function one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length ? rows[0] : null;
}

export async function tx<T>(fn: (c: { query: typeof query }) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const wrapped = async (text: string, params: unknown[] = []) => {
      const r = await client.query(text, params as any[]);
      return r.rows;
    };
    const out = await fn({ query: wrapped as typeof query });
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* --------------------------------------------------------------- миграции -- */

async function ensureMigrationsTable(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

export async function migrate(): Promise<void> {
  mkdirSync(config.sqlDir, { recursive: true });
  await ensureMigrationsTable();
  const applied = new Set((await query<{ name: string }>('SELECT name FROM _migrations')).map((r) => r.name));
  const files = readdirSync(config.sqlDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(config.sqlDir, file), 'utf8');
    console.log(`[db] applying ${file}`);
    await tx(async ({ query: q }) => {
      await q(sql);
      await q('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    });
  }
  console.log(`[db] schema up to date (${files.length} migration(s))`);
}
