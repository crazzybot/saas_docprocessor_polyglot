/**
 * PostgreSQL connection pool and schema migrations.
 *
 * In Azure the service authenticates to Azure Database for PostgreSQL with
 * Microsoft Entra ID: node-postgres calls the password function for every new
 * connection, which returns a fresh access token from the Workload Identity
 * credential, so no database password is stored anywhere.
 */

import { readdir, readFile } from 'node:fs/promises';

import { getLogger, type TokenCredential } from '@docprocessor/shared';
import pg from 'pg';

import type { Settings } from '../../config.js';

const logger = getLogger('document_service.adapters.postgres.database');

const ENTRA_POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const MIGRATIONS_DIR = new URL('./migrations/', import.meta.url);
// Arbitrary constant identifying this service's migration lock.
const MIGRATION_LOCK_ID = 4_242_001;

export function entraPasswordProvider(credential: TokenCredential): () => Promise<string> {
  return async () => {
    const token = await credential.getToken(ENTRA_POSTGRES_SCOPE);
    if (!token) {
      throw new Error('could not acquire an Entra ID token for PostgreSQL');
    }
    return token.token;
  };
}

export function createPool(
  settings: Pick<
    Settings,
    'databaseUrl' | 'postgresEntraAuth' | 'dbPoolMinSize' | 'dbPoolMaxSize' | 'dbCommandTimeoutSeconds'
  >,
  options: { credential?: TokenCredential } = {},
): pg.Pool {
  let password: (() => Promise<string>) | undefined;
  if (settings.postgresEntraAuth) {
    if (!options.credential) {
      throw new Error('POSTGRES_ENTRA_AUTH requires an Azure credential');
    }
    password = entraPasswordProvider(options.credential);
  }
  logger.info('db_pool_create', { auth: password ? 'entra_id' : 'dsn', max_size: settings.dbPoolMaxSize });
  const timeoutMs = settings.dbCommandTimeoutSeconds * 1000;
  const pool = new pg.Pool({
    connectionString: settings.databaseUrl,
    ...(password ? { password } : {}),
    min: settings.dbPoolMinSize,
    max: settings.dbPoolMaxSize,
    query_timeout: timeoutMs,
    connectionTimeoutMillis: timeoutMs,
    // Entra tokens live ~1 hour; recycle idle connections well before that
    // is relevant, and so the pool shrinks after bursts.
    idleTimeoutMillis: 300_000,
  });
  // An idle client losing its connection emits on the pool; without a
  // listener that would crash the process.
  pool.on('error', (error) => logger.warn('db_idle_client_error', {}, error));
  return pool;
}

/**
 * Apply pending `migrations/*.sql` files in name order, each in its own
 * transaction. A session-level advisory lock serialises replicas that start
 * at the same time. Returns the names of the migrations applied.
 */
export async function runMigrations(pool: pg.Pool, migrationsDir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const appliedNow: string[] = [];
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    try {
      await client.query(
        'CREATE TABLE IF NOT EXISTS schema_migrations (' +
          ' version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
      const done = new Set(rows.map((row) => row.version));
      const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
      for (const name of files) {
        if (done.has(name)) {
          continue;
        }
        const sql = await readFile(new URL(name, migrationsDir), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [name]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
        appliedNow.push(name);
        logger.info('db_migration_applied', { version: name });
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
  return appliedNow;
}
