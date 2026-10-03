/**
 * Ports: the interfaces the application layer depends on.
 *
 * Adapters implement them against real infrastructure
 * (`adapters/postgres/repository.ts`, `adapters/blob-storage.ts`); tests use
 * in-memory fakes. The symbols are Nest injection tokens for each port.
 */

import type { Readable } from 'node:stream';

import type {
  BlobRef,
  Document,
  DocumentChanges,
  DocumentPage,
  DocumentStatus,
  ExtractionResult,
  OutboxEvent,
  OutboxRecord,
  PageCursor,
  ResultOutcome,
} from '../domain/models.js';

export const DOCUMENT_REPOSITORY = Symbol('DocumentRepository');
export const DOCUMENT_STORAGE = Symbol('DocumentStorage');

export type EventFactory = (doc: Document) => OutboxEvent;
export type OutboxSender = (records: readonly OutboxRecord[]) => Promise<void>;

/** The document catalog plus its transactional outbox. */
export interface DocumentRepository {
  ping(): Promise<void>;

  create(doc: Document, event: OutboxEvent): Promise<void>;

  /** The live (not deleted) document, or null. */
  get(tenantId: string, docId: string): Promise<Document | null>;

  /** Newest first, keyset-paginated, live documents only. */
  listDocuments(
    tenantId: string,
    options: { limit: number; cursor: PageCursor | null; status: DocumentStatus | null },
  ): Promise<DocumentPage>;

  update(
    tenantId: string,
    docId: string,
    changes: DocumentChanges,
    options: { expectedVersion: number | null; makeEvent: EventFactory },
  ): Promise<Document>;

  /** Turn the document into a tombstone; returns the tombstone. */
  markDeleted(
    tenantId: string,
    docId: string,
    options: { expectedVersion: number | null; makeEvent: EventFactory },
  ): Promise<Document>;

  /**
   * Record the worker's outcome. Status only moves forward: the first
   * terminal result wins and later ones are ignored.
   */
  applyExtractionResult(result: ExtractionResult): Promise<[ResultOutcome, Document | null]>;

  listTombstonesWithBlobs(limit: number): Promise<Document[]>;

  /** Mark a tombstone's blobs as removed, unless it changed since `version`. */
  markBlobsDeleted(tenantId: string, docId: string, version: number): Promise<void>;

  purgeTombstones(olderThan: Date): Promise<number>;

  purgePublishedOutbox(olderThan: Date): Promise<number>;

  /**
   * Hand up to `limit` unpublished events to `send` and mark them published
   * if it resolves. Returns the number published.
   */
  publishOutbox(limit: number, send: OutboxSender): Promise<number>;
}

export interface BlobStream {
  readonly size: number;
  readonly stream: Readable;
}

/** Raw documents and extraction results in object storage. */
export interface DocumentStorage {
  /** Store bytes and return the blob URL. */
  upload(
    ref: BlobRef,
    data: Buffer,
    options: { contentType: string; metadata: Readonly<Record<string, string>> },
  ): Promise<string>;

  /** Start a download; rejects with ContentMissingError if the blob is gone. */
  openStream(ref: BlobRef): Promise<BlobStream>;

  readExtractedText(ref: BlobRef): Promise<string>;

  /** Idempotent: deleting a blob that is already gone succeeds. */
  delete(ref: BlobRef): Promise<void>;

  ping(container: string): Promise<void>;
}
