/**
 * In-memory stand-ins for the repository and Blob Storage.
 *
 * `InMemoryDocumentRepository` mirrors `PostgresDocumentRepository`'s
 * semantics (tenant scoping, keyset paging, versioning, outbox, tombstones);
 * `postgres-repository.test.ts` runs the same scenarios against a real
 * database so the two cannot drift silently.
 */

import { Readable } from 'node:stream';

import type {
  BlobStream,
  DocumentRepository,
  DocumentStorage,
  EventFactory,
  OutboxSender,
} from '../src/application/ports.js';
import {
  ContentMissingError,
  DocumentNotFoundError,
  StorageUnavailableError,
  VersionConflictError,
} from '../src/domain/errors.js';
import {
  DocumentStatus,
  PageCursor,
  ResultOutcome,
  type BlobRef,
  type Document,
  type DocumentChanges,
  type DocumentPage,
  type ExtractionResult,
  type OutboxEvent,
  type OutboxRecord,
} from '../src/domain/models.js';

/** Newest first: (createdAt, id) descending. */
function compareKeys(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  return byTime !== 0 ? byTime : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class InMemoryDocumentRepository implements DocumentRepository {
  docs = new Map<string, Document>();
  blobsDeleted = new Map<string, boolean>();
  outbox: Array<{ record: OutboxRecord; publishedAt: Date | null }> = [];
  failWith: Error | null = null;
  private nextId = 1;

  private check(): void {
    if (this.failWith) {
      throw this.failWith;
    }
  }

  private addEvent(event: OutboxEvent): void {
    this.outbox.push({ record: { id: this.nextId++, event }, publishedAt: null });
  }

  private live(tenantId: string, docId: string): Document {
    const doc = this.docs.get(docId);
    if (!doc || doc.tenantId !== tenantId || doc.deletedAt !== null) {
      throw new DocumentNotFoundError(docId);
    }
    return doc;
  }

  get events(): OutboxEvent[] {
    return this.outbox.map((entry) => entry.record.event);
  }

  async ping(): Promise<void> {
    this.check();
  }

  async create(doc: Document, event: OutboxEvent): Promise<void> {
    this.check();
    this.docs.set(doc.id, doc);
    this.addEvent(event);
  }

  async get(tenantId: string, docId: string): Promise<Document | null> {
    this.check();
    try {
      return this.live(tenantId, docId);
    } catch {
      return null;
    }
  }

  async listDocuments(
    tenantId: string,
    options: { limit: number; cursor: PageCursor | null; status: DocumentStatus | null },
  ): Promise<DocumentPage> {
    this.check();
    let docs = [...this.docs.values()]
      .filter(
        (d) =>
          d.tenantId === tenantId && d.deletedAt === null && (options.status === null || d.status === options.status),
      )
      .sort((a, b) => compareKeys(b, a));
    const cursor = options.cursor;
    if (cursor) {
      docs = docs.filter((d) => compareKeys(d, { createdAt: cursor.createdAt, id: cursor.docId }) < 0);
    }
    const items = docs.slice(0, options.limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: docs.length > options.limit && last ? new PageCursor(last.createdAt, last.id) : null,
    };
  }

  async update(
    tenantId: string,
    docId: string,
    changes: DocumentChanges,
    options: { expectedVersion: number | null; makeEvent: EventFactory },
  ): Promise<Document> {
    this.check();
    let doc = this.live(tenantId, docId);
    if (options.expectedVersion !== null && doc.version !== options.expectedVersion) {
      throw new VersionConflictError(doc.version);
    }
    doc = {
      ...doc,
      version: doc.version + 1,
      updatedAt: new Date(),
      ...(changes.title !== undefined ? { title: changes.title } : {}),
      ...(changes.tags !== undefined ? { tags: [...changes.tags] } : {}),
      ...(changes.metadata !== undefined ? { metadata: { ...changes.metadata } } : {}),
    };
    this.docs.set(docId, doc);
    this.addEvent(options.makeEvent(doc));
    return doc;
  }

  async markDeleted(
    tenantId: string,
    docId: string,
    options: { expectedVersion: number | null; makeEvent: EventFactory },
  ): Promise<Document> {
    this.check();
    let doc = this.live(tenantId, docId);
    if (options.expectedVersion !== null && doc.version !== options.expectedVersion) {
      throw new VersionConflictError(doc.version);
    }
    const now = new Date();
    doc = { ...doc, deletedAt: now, updatedAt: now, version: doc.version + 1 };
    this.docs.set(docId, doc);
    this.blobsDeleted.set(docId, false);
    this.addEvent(options.makeEvent(doc));
    return doc;
  }

  async applyExtractionResult(result: ExtractionResult): Promise<[ResultOutcome, Document | null]> {
    this.check();
    let doc = this.docs.get(result.docId);
    if (!doc || doc.tenantId !== result.tenantId) {
      return [ResultOutcome.NOT_FOUND, null];
    }
    if (doc.status !== DocumentStatus.QUEUED) {
      return [ResultOutcome.IGNORED, doc];
    }
    doc = {
      ...doc,
      status: result.status,
      error: result.error,
      textBlob: result.textBlob,
      extractedAt: result.completedAt,
      updatedAt: new Date(),
      version: doc.version + 1,
    };
    this.docs.set(doc.id, doc);
    if (doc.deletedAt !== null) {
      if (result.textBlob !== null) {
        this.blobsDeleted.set(doc.id, false);
      }
      return [ResultOutcome.TOMBSTONED, doc];
    }
    return [ResultOutcome.APPLIED, doc];
  }

  async listTombstonesWithBlobs(limit: number): Promise<Document[]> {
    this.check();
    return [...this.blobsDeleted.entries()]
      .filter(([id, done]) => !done && this.docs.has(id))
      .map(([id]) => this.docs.get(id) as Document)
      .slice(0, limit);
  }

  async markBlobsDeleted(tenantId: string, docId: string, version: number): Promise<void> {
    this.check();
    const doc = this.docs.get(docId);
    if (doc && doc.tenantId === tenantId && doc.version === version) {
      this.blobsDeleted.set(docId, true);
    }
  }

  async purgeTombstones(olderThan: Date): Promise<number> {
    this.check();
    const purge = [...this.docs.values()].filter(
      (d) => d.deletedAt !== null && d.deletedAt < olderThan && this.blobsDeleted.get(d.id),
    );
    for (const doc of purge) {
      this.docs.delete(doc.id);
      this.blobsDeleted.delete(doc.id);
    }
    return purge.length;
  }

  async purgePublishedOutbox(olderThan: Date): Promise<number> {
    this.check();
    const before = this.outbox.length;
    this.outbox = this.outbox.filter((entry) => entry.publishedAt === null || entry.publishedAt >= olderThan);
    return before - this.outbox.length;
  }

  async publishOutbox(limit: number, send: OutboxSender): Promise<number> {
    this.check();
    const pending = this.outbox.filter((entry) => entry.publishedAt === null).slice(0, limit);
    if (pending.length === 0) {
      return 0;
    }
    await send(pending.map((entry) => entry.record));
    const now = new Date();
    for (const entry of pending) {
      entry.publishedAt = now;
    }
    return pending.length;
  }
}

const key = (ref: BlobRef): string => `${ref.container}/${ref.name}`;

/** Blob Storage keyed by container and name. */
export class FakeStorage implements DocumentStorage {
  blobs = new Map<string, Buffer>();
  metadata = new Map<string, Readonly<Record<string, string>>>();
  failWith: Error | null = null;
  failDeletes = false;

  private check(): void {
    if (this.failWith) {
      throw this.failWith;
    }
  }

  blobUrl(ref: BlobRef): string {
    return `https://acct.blob.core.windows.net/${ref.container}/${ref.name}`;
  }

  has(ref: BlobRef): boolean {
    return this.blobs.has(key(ref));
  }

  put(ref: BlobRef, data: Buffer | string): void {
    this.blobs.set(key(ref), Buffer.from(data));
  }

  async upload(
    ref: BlobRef,
    data: Buffer,
    options: { contentType: string; metadata: Readonly<Record<string, string>> },
  ): Promise<string> {
    this.check();
    this.blobs.set(key(ref), data);
    this.metadata.set(key(ref), { ...options.metadata });
    return this.blobUrl(ref);
  }

  async openStream(ref: BlobRef): Promise<BlobStream> {
    this.check();
    const data = this.blobs.get(key(ref));
    if (!data) {
      throw new ContentMissingError(ref.name);
    }
    const chunks: Buffer[] = [];
    for (let i = 0; i < data.length; i += 4) {
      chunks.push(data.subarray(i, i + 4));
    }
    return { size: data.length, stream: Readable.from(chunks) };
  }

  async readExtractedText(ref: BlobRef): Promise<string> {
    this.check();
    const data = this.blobs.get(key(ref));
    if (!data) {
      throw new ContentMissingError(ref.name);
    }
    return (JSON.parse(data.toString('utf8')) as { extracted_text: string }).extracted_text;
  }

  async delete(ref: BlobRef): Promise<void> {
    if (this.failDeletes) {
      throw new StorageUnavailableError('delete failed');
    }
    this.check();
    this.blobs.delete(key(ref));
  }

  async ping(): Promise<void> {
    this.check();
  }
}
