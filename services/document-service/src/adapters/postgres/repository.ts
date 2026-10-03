/**
 * PostgreSQL implementation of the `DocumentRepository` port.
 *
 * Every state change that other services must hear about is written together
 * with its outbox event in a single transaction, and the outbox relay
 * publishes it afterwards (transactional outbox pattern).
 */

import pg from 'pg';

import type { DocumentRepository, EventFactory, OutboxSender } from '../../application/ports.js';
import { DocumentNotFoundError, RepositoryUnavailableError, VersionConflictError } from '../../domain/errors.js';
import {
  DocumentStatus,
  PageCursor,
  ResultOutcome,
  type Document,
  type DocumentChanges,
  type DocumentPage,
  type EventType,
  type ExtractionResult,
  type OutboxEvent,
  type OutboxRecord,
} from '../../domain/models.js';

interface DocumentRow {
  id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number; // bigint arrives as a string
  status: DocumentStatus;
  error: string | null;
  raw_blob_container: string;
  raw_blob_name: string;
  text_blob_container: string | null;
  text_blob_name: string | null;
  title: string | null;
  tags: string[];
  metadata: Record<string, string>;
  version: number;
  created_at: Date;
  updated_at: Date;
  extracted_at: Date | null;
  deleted_at: Date | null;
}

// Connection-level failures, as opposed to bugs in this code. Errors from an
// outbox `send` callback are not database errors and propagate unchanged.
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

function isDatabaseError(error: unknown): boolean {
  if (error instanceof pg.DatabaseError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return (
    (code !== undefined && NETWORK_ERROR_CODES.has(code)) ||
    /Connection terminated|timeout exceeded when trying to connect|Query read timeout|Client has encountered a connection error/i.test(
      error.message,
    )
  );
}

async function dbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isDatabaseError(error)) {
      throw new RepositoryUnavailableError(`database error: ${(error as Error).message}`, { cause: error });
    }
    throw error;
  }
}

function rowToDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    error: row.error,
    rawBlob: { container: row.raw_blob_container, name: row.raw_blob_name },
    textBlob:
      row.text_blob_name !== null ? { container: row.text_blob_container ?? '', name: row.text_blob_name } : null,
    title: row.title,
    tags: row.tags,
    metadata: row.metadata,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    extractedAt: row.extracted_at,
    deletedAt: row.deleted_at,
  };
}

function requireRow(row: DocumentRow | undefined): DocumentRow {
  if (row === undefined) {
    throw new Error('statement returned no row');
  }
  return row;
}

export class PostgresDocumentRepository implements DocumentRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Run `fn` in a transaction on one connection; roll back if it throws. */
  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return dbErrors(async () => {
      const client = await this.pool.connect();
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // the connection is unusable: discard it
        }
        throw error;
      } finally {
        client.release(broken);
      }
    });
  }

  private static async insertOutbox(client: pg.PoolClient, event: OutboxEvent): Promise<void> {
    await client.query('INSERT INTO outbox (message_id, event_type, body, properties) VALUES ($1, $2, $3, $4)', [
      event.messageId,
      event.eventType,
      event.body,
      event.properties,
    ]);
  }

  private static async lockLive(client: pg.PoolClient, tenantId: string, docId: string): Promise<number> {
    const { rows } = await client.query<{ version: number }>(
      'SELECT version FROM documents WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE',
      [tenantId, docId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new DocumentNotFoundError(docId);
    }
    return row.version;
  }

  async ping(): Promise<void> {
    await dbErrors(() => this.pool.query('SELECT 1'));
  }

  async create(doc: Document, event: OutboxEvent): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        `INSERT INTO documents (
            id, tenant_id, filename, content_type, size_bytes, status, error,
            raw_blob_container, raw_blob_name, title, tags, metadata,
            version, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          doc.id,
          doc.tenantId,
          doc.filename,
          doc.contentType,
          doc.sizeBytes,
          doc.status,
          doc.error,
          doc.rawBlob.container,
          doc.rawBlob.name,
          doc.title,
          [...doc.tags],
          doc.metadata,
          doc.version,
          doc.createdAt,
          doc.updatedAt,
        ],
      );
      await PostgresDocumentRepository.insertOutbox(client, event);
    });
  }

  async get(tenantId: string, docId: string): Promise<Document | null> {
    const { rows } = await dbErrors(() =>
      this.pool.query<DocumentRow>('SELECT * FROM documents WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL', [
        tenantId,
        docId,
      ]),
    );
    return rows[0] ? rowToDocument(rows[0]) : null;
  }

  async listDocuments(
    tenantId: string,
    options: { limit: number; cursor: PageCursor | null; status: DocumentStatus | null },
  ): Promise<DocumentPage> {
    const conditions = ['tenant_id = $1', 'deleted_at IS NULL'];
    const args: unknown[] = [tenantId];
    if (options.status !== null) {
      args.push(options.status);
      conditions.push(`status = $${args.length}`);
    }
    if (options.cursor !== null) {
      args.push(options.cursor.createdAt, options.cursor.docId);
      conditions.push(`(created_at, id) < ($${args.length - 1}, $${args.length})`);
    }
    args.push(options.limit + 1); // one extra row tells us whether there is a next page
    const query =
      `SELECT * FROM documents WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY created_at DESC, id DESC LIMIT $${args.length}`;
    const { rows } = await dbErrors(() => this.pool.query<DocumentRow>(query, args));
    const items = rows.slice(0, options.limit).map(rowToDocument);
    const last = items.at(-1);
    const nextCursor = rows.length > options.limit && last ? new PageCursor(last.createdAt, last.id) : null;
    return { items, nextCursor };
  }

  async update(
    tenantId: string,
    docId: string,
    changes: DocumentChanges,
    options: { expectedVersion: number | null; makeEvent: EventFactory },
  ): Promise<Document> {
    const sets = ['version = version + 1', 'updated_at = $3'];
    const args: unknown[] = [tenantId, docId, new Date()];
    if (changes.title !== undefined) {
      args.push(changes.title);
      sets.push(`title = $${args.length}`);
    }
    if (changes.tags !== undefined) {
      args.push([...changes.tags]);
      sets.push(`tags = $${args.length}`);
    }
    if (changes.metadata !== undefined) {
      args.push(changes.metadata);
      sets.push(`metadata = $${args.length}`);
    }
    return this.transaction(async (client) => {
      const current = await PostgresDocumentRepository.lockLive(client, tenantId, docId);
      if (options.expectedVersion !== null && current !== options.expectedVersion) {
        throw new VersionConflictError(current);
      }
      const { rows } = await client.query<DocumentRow>(
        `UPDATE documents SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
        args,
      );
      const doc = rowToDocument(requireRow(rows[0]));
      await PostgresDocumentRepository.insertOutbox(client, options.makeEvent(doc));
      return doc;
    });
  }

  async markDeleted(
    tenantId: string,
    docId: string,
    options: { expectedVersion: number | null; makeEvent: EventFactory },
  ): Promise<Document> {
    return this.transaction(async (client) => {
      const current = await PostgresDocumentRepository.lockLive(client, tenantId, docId);
      if (options.expectedVersion !== null && current !== options.expectedVersion) {
        throw new VersionConflictError(current);
      }
      const { rows } = await client.query<DocumentRow>(
        `UPDATE documents
            SET deleted_at = $3, updated_at = $3, version = version + 1, blobs_deleted = false
          WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [tenantId, docId, new Date()],
      );
      const doc = rowToDocument(requireRow(rows[0]));
      await PostgresDocumentRepository.insertOutbox(client, options.makeEvent(doc));
      return doc;
    });
  }

  async applyExtractionResult(result: ExtractionResult): Promise<[ResultOutcome, Document | null]> {
    return this.transaction(async (client) => {
      const existing = await client.query<DocumentRow>(
        'SELECT * FROM documents WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
        [result.tenantId, result.docId],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        return [ResultOutcome.NOT_FOUND, null];
      }
      if (row.status !== DocumentStatus.QUEUED) {
        return [ResultOutcome.IGNORED, rowToDocument(row)];
      }
      const textBlob = result.textBlob;
      const { rows } = await client.query<DocumentRow>(
        `UPDATE documents
            SET status = $3, error = $4, text_blob_container = $5, text_blob_name = $6,
                extracted_at = $7, updated_at = $8, version = version + 1,
                -- a result for a tombstone leaves a new blob behind to clean up
                blobs_deleted = CASE WHEN deleted_at IS NOT NULL AND $6::text IS NOT NULL
                                     THEN false ELSE blobs_deleted END
          WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          result.tenantId,
          result.docId,
          result.status,
          result.error,
          textBlob?.container ?? null,
          textBlob?.name ?? null,
          result.completedAt,
          new Date(),
        ],
      );
      const doc = rowToDocument(requireRow(rows[0]));
      return [doc.deletedAt ? ResultOutcome.TOMBSTONED : ResultOutcome.APPLIED, doc];
    });
  }

  async listTombstonesWithBlobs(limit: number): Promise<Document[]> {
    const { rows } = await dbErrors(() =>
      this.pool.query<DocumentRow>(
        'SELECT * FROM documents WHERE deleted_at IS NOT NULL AND NOT blobs_deleted ORDER BY deleted_at LIMIT $1',
        [limit],
      ),
    );
    return rows.map(rowToDocument);
  }

  async markBlobsDeleted(tenantId: string, docId: string, version: number): Promise<void> {
    await dbErrors(() =>
      this.pool.query('UPDATE documents SET blobs_deleted = true WHERE tenant_id = $1 AND id = $2 AND version = $3', [
        tenantId,
        docId,
        version,
      ]),
    );
  }

  async purgeTombstones(olderThan: Date): Promise<number> {
    const result = await dbErrors(() =>
      this.pool.query('DELETE FROM documents WHERE deleted_at < $1 AND blobs_deleted', [olderThan]),
    );
    return result.rowCount ?? 0;
  }

  async purgePublishedOutbox(olderThan: Date): Promise<number> {
    const result = await dbErrors(() => this.pool.query('DELETE FROM outbox WHERE published_at < $1', [olderThan]));
    return result.rowCount ?? 0;
  }

  /**
   * Rows are locked with SKIP LOCKED for the duration of the send, so
   * replicas relay disjoint batches; if `send` rejects, the transaction rolls
   * back and the rows are retried (at-least-once delivery).
   */
  async publishOutbox(limit: number, send: OutboxSender): Promise<number> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<{
        id: string;
        message_id: string;
        event_type: EventType;
        body: Record<string, unknown>;
        properties: Record<string, string>;
      }>(
        'SELECT id, message_id, event_type, body, properties FROM outbox ' +
          'WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED',
        [limit],
      );
      if (rows.length === 0) {
        return 0;
      }
      const records: OutboxRecord[] = rows.map((row) => ({
        id: Number(row.id),
        event: { eventType: row.event_type, messageId: row.message_id, body: row.body, properties: row.properties },
      }));
      await send(records);
      await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [
        records.map((record) => record.id),
      ]);
      return records.length;
    });
  }
}
