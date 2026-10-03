/**
 * Integration tests for `PostgresDocumentRepository` against a real database.
 *
 * Skipped unless TEST_DATABASE_URL points at a disposable PostgreSQL database
 * (CI provides one as a service container; locally, `just test-postgres`).
 * Each test starts from empty tables.
 */

import { randomUUID } from 'node:crypto';

import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPool, runMigrations } from '../src/adapters/postgres/database.js';
import { PostgresDocumentRepository } from '../src/adapters/postgres/repository.js';
import type { EventFactory } from '../src/application/ports.js';
import * as events from '../src/domain/events.js';
import { DocumentNotFoundError, RepositoryUnavailableError, VersionConflictError } from '../src/domain/errors.js';
import {
  DocumentStatus,
  newDocument,
  ResultOutcome,
  type Document,
  type ExtractionResult,
  type OutboxRecord,
} from '../src/domain/models.js';
import { testSettings } from './support.js';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TENANT = 'tenant-a';
const OTHER = 'tenant-b';

const updated: EventFactory = (d) => events.documentUpdated(d, { correlationId: 'c' });
const deleted: EventFactory = (d) => events.documentDeleted(d, { correlationId: 'c' });

function makeDoc(tenantId = TENANT, createdAt = new Date()): Document {
  const id = randomUUID();
  return newDocument({
    id,
    tenantId,
    filename: 'a.pdf',
    contentType: 'application/pdf',
    sizeBytes: 8,
    rawBlob: { container: 'raw-documents', name: `${tenantId}/${id}/a.pdf` },
    createdAt,
  });
}

function resultFor(doc: Document, status: DocumentStatus = DocumentStatus.SUCCEEDED): ExtractionResult {
  return {
    tenantId: doc.tenantId,
    docId: doc.id,
    status,
    textBlob: { container: 'extraction-results', name: `${doc.tenantId}/${doc.id}.json` },
    error: null,
    completedAt: new Date(),
  };
}

describe.skipIf(!TEST_DATABASE_URL)('PostgresDocumentRepository', () => {
  let pool: pg.Pool;
  let repo: PostgresDocumentRepository;

  beforeEach(async () => {
    pool = createPool(testSettings({ databaseUrl: TEST_DATABASE_URL ?? '', dbPoolMinSize: 1, dbPoolMaxSize: 4 }));
    await runMigrations(pool);
    await pool.query('TRUNCATE documents, outbox RESTART IDENTITY');
    repo = new PostgresDocumentRepository(pool);
  });

  afterEach(async () => {
    await pool.end();
  });

  async function create(doc: Document): Promise<Document> {
    await repo.create(doc, events.documentUploaded(doc, { blobUrl: 'u', correlationId: 'c', traceContext: {} }));
    return doc;
  }

  it('applies migrations idempotently', async () => {
    expect(await runMigrations(pool)).toEqual([]);
  });

  it('round-trips create and get, with the outbox row', async () => {
    const doc = await create(makeDoc());

    expect(await repo.get(TENANT, doc.id)).toEqual(doc);
    expect(await repo.get(OTHER, doc.id)).toBeNull();
    const { rows } = await pool.query('SELECT * FROM outbox');
    expect(rows[0]).toMatchObject({
      message_id: doc.id,
      body: { blob_name: doc.rawBlob.name },
      properties: { event_type: 'document.uploaded' },
    });
  });

  it('pages by keyset and filters by status', async () => {
    const base = Date.UTC(2026, 0, 1);
    const docs: Document[] = [];
    for (let i = 0; i < 5; i++) {
      docs.push(await create(makeDoc(TENANT, new Date(base + i * 1000))));
    }
    // Same timestamp: the id breaks the tie deterministically.
    const twins = [
      await create(makeDoc(TENANT, new Date(base + 10_000))),
      await create(makeDoc(TENANT, new Date(base + 10_000))),
    ];
    await create(makeDoc(OTHER));
    await repo.applyExtractionResult(resultFor(docs[0] as Document));

    const seen: string[] = [];
    let cursor = null;
    do {
      const page = await repo.listDocuments(TENANT, { limit: 3, cursor, status: null });
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor;
    } while (cursor);

    const expected = [...twins.sort((a, b) => (a.id < b.id ? 1 : -1)), ...docs.toReversed()];
    expect(seen).toEqual(expected.map((d) => d.id));
    const succeeded = await repo.listDocuments(TENANT, { limit: 10, cursor: null, status: DocumentStatus.SUCCEEDED });
    expect(succeeded.items.map((d) => d.id)).toEqual([docs[0]?.id]);
  });

  it('updates with a version check', async () => {
    const doc = await create(makeDoc());
    const changes = { title: 'T', tags: ['a', 'b'], metadata: { k: 'v' } };

    const result = await repo.update(TENANT, doc.id, changes, { expectedVersion: 1, makeEvent: updated });

    expect(result).toMatchObject({ title: 'T', tags: ['a', 'b'], metadata: { k: 'v' }, version: 2 });
    await expect(repo.update(TENANT, doc.id, changes, { expectedVersion: 1, makeEvent: updated })).rejects.toEqual(
      new VersionConflictError(2),
    );
    await expect(
      repo.update(OTHER, doc.id, changes, { expectedVersion: null, makeEvent: updated }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM outbox');
    expect(rows[0]?.count).toBe('2');
  });

  it('only moves the extraction status forward', async () => {
    const doc = await create(makeDoc());

    const [first, applied] = await repo.applyExtractionResult(resultFor(doc));
    const [second] = await repo.applyExtractionResult(resultFor(doc, DocumentStatus.FAILED));
    const [missing] = await repo.applyExtractionResult(resultFor(makeDoc()));

    expect(first).toBe(ResultOutcome.APPLIED);
    expect(applied).toMatchObject({ status: DocumentStatus.SUCCEEDED, version: 2 });
    expect(second).toBe(ResultOutcome.IGNORED);
    expect(missing).toBe(ResultOutcome.NOT_FOUND);
  });

  it('tombstones on delete, tracks a late result, and purges', async () => {
    const doc = await create(makeDoc());
    const tombstone = await repo.markDeleted(TENANT, doc.id, { expectedVersion: null, makeEvent: deleted });
    await repo.markBlobsDeleted(TENANT, doc.id, tombstone.version);

    expect(await repo.get(TENANT, doc.id)).toBeNull();
    expect((await repo.listDocuments(TENANT, { limit: 10, cursor: null, status: null })).items).toEqual([]);
    await expect(
      repo.markDeleted(TENANT, doc.id, { expectedVersion: null, makeEvent: deleted }),
    ).rejects.toBeInstanceOf(DocumentNotFoundError);

    // A late result for the tombstone leaves a new blob to clean up.
    const [outcome, late] = await repo.applyExtractionResult(resultFor(doc));
    expect(outcome).toBe(ResultOutcome.TOMBSTONED);
    expect((await repo.listTombstonesWithBlobs(10)).map((d) => d.id)).toEqual([doc.id]);

    await repo.markBlobsDeleted(TENANT, doc.id, late?.version ?? 0);
    expect(await repo.listTombstonesWithBlobs(10)).toEqual([]);
    expect(await repo.purgeTombstones(new Date(Date.now() + 1000))).toBe(1);
  });

  it('ignores markBlobsDeleted for a stale version', async () => {
    const doc = await create(makeDoc());
    const tombstone = await repo.markDeleted(TENANT, doc.id, { expectedVersion: null, makeEvent: deleted });
    await repo.applyExtractionResult(resultFor(doc)); // bumps the version

    await repo.markBlobsDeleted(TENANT, doc.id, tombstone.version);

    expect((await repo.listTombstonesWithBlobs(10)).map((d) => d.id)).toEqual([doc.id]);
  });

  it('publishes the outbox transactionally, with SKIP LOCKED', async () => {
    for (let i = 0; i < 4; i++) {
      await create(makeDoc());
    }

    const brokerDown = new Error('broker down');
    await expect(
      repo.publishOutbox(10, async () => {
        throw brokerDown;
      }),
    ).rejects.toBe(brokerDown); // not mistaken for a database error
    const pending = await pool.query<{ count: string }>('SELECT count(*) FROM outbox WHERE published_at IS NULL');
    expect(pending.rows[0]?.count).toBe('4');

    // Two relays running concurrently get disjoint batches.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const batches: number[][] = [];
    const slowSend = async (records: readonly OutboxRecord[]) => {
      batches.push(records.map((r) => r.id));
      await gate;
    };
    const first = repo.publishOutbox(2, slowSend);
    const second = repo.publishOutbox(2, slowSend);
    while (batches.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    release();
    expect((await first) + (await second)).toBe(4);
    expect(batches.flat().sort()).toEqual([1, 2, 3, 4]);

    expect(await repo.purgePublishedOutbox(new Date(Date.now() + 1000))).toBe(4);
  });

  it('reports an unreachable database as RepositoryUnavailableError', async () => {
    const down = createPool(
      testSettings({ databaseUrl: 'postgresql://x:y@127.0.0.1:1/none', dbCommandTimeoutSeconds: 2 }),
    );
    try {
      await expect(new PostgresDocumentRepository(down).ping()).rejects.toBeInstanceOf(RepositoryUnavailableError);
    } finally {
      await down.end();
    }
  });
});
