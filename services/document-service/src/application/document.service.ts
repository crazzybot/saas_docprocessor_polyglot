/**
 * Document use cases: the only layer the HTTP controllers and consumers call.
 *
 * It coordinates the catalog and object storage through their ports, so it
 * has no knowledge of PostgreSQL, Azure, Nest, or HTTP.
 */

import { randomUUID } from 'node:crypto';

import { getLogger } from '@docprocessor/shared';

import {
  DocumentNotFoundError,
  RepositoryUnavailableError,
  StorageUnavailableError,
  TextNotAvailableError,
  VersionConflictError,
} from '../domain/errors.js';
import * as events from '../domain/events.js';
import {
  DocumentStatus,
  isEmptyChanges,
  newDocument,
  ResultOutcome,
  type BlobRef,
  type Document,
  type DocumentChanges,
  type DocumentPage,
  type ExtractionResult,
  type PageCursor,
} from '../domain/models.js';
import type { BlobStream, DocumentRepository, DocumentStorage } from './ports.js';

const logger = getLogger('document_service.application.service');

export interface UploadCommand {
  tenantId: string;
  filename: string;
  contentType: string;
  data: Buffer;
  correlationId: string;
  traceContext: Readonly<Record<string, string>>;
  docId?: string;
}

export class DocumentService {
  constructor(
    private readonly repo: DocumentRepository,
    private readonly storage: DocumentStorage,
    private readonly options: {
      rawContainer: string;
      /**
       * Wakes the outbox relay right after a commit, so events go out
       * without waiting for the next poll.
       */
      notifyOutbox?: () => void;
    },
  ) {}

  private notifyOutbox(): void {
    this.options.notifyOutbox?.();
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /**
   * Store the file, then record the document and its `uploaded` event in one
   * transaction. Returns the document and its raw blob URL.
   *
   * The blob is written first because it cannot join the database
   * transaction. If the commit fails, the blob is removed (best effort) and
   * the error propagates, so the client never sees an ID that the catalog
   * does not know.
   */
  async upload(command: UploadCommand): Promise<{ doc: Document; blobUrl: string }> {
    const docId = command.docId ?? randomUUID();
    const rawBlob: BlobRef = {
      container: this.options.rawContainer,
      name: `${command.tenantId}/${docId}/${command.filename}`,
    };
    const blobUrl = await this.storage.upload(rawBlob, command.data, {
      contentType: command.contentType,
      metadata: { doc_id: docId, tenant_id: command.tenantId, original_filename: command.filename },
    });
    const doc = newDocument({
      id: docId,
      tenantId: command.tenantId,
      filename: command.filename,
      contentType: command.contentType,
      sizeBytes: command.data.length,
      rawBlob,
      createdAt: new Date(),
    });
    const event = events.documentUploaded(doc, {
      blobUrl,
      correlationId: command.correlationId,
      traceContext: command.traceContext,
    });
    try {
      await this.repo.create(doc, event);
    } catch (error) {
      await this.deleteBlobBestEffort(rawBlob);
      throw error;
    }
    this.notifyOutbox();
    return { doc, blobUrl };
  }

  async update(
    tenantId: string,
    docId: string,
    changes: DocumentChanges,
    options: { expectedVersion: number | null; correlationId: string },
  ): Promise<Document> {
    if (isEmptyChanges(changes)) {
      const doc = await this.get(tenantId, docId);
      if (options.expectedVersion !== null && doc.version !== options.expectedVersion) {
        throw new VersionConflictError(doc.version);
      }
      return doc;
    }
    const doc = await this.repo.update(tenantId, docId, changes, {
      expectedVersion: options.expectedVersion,
      makeEvent: (d) => events.documentUpdated(d, { correlationId: options.correlationId }),
    });
    this.notifyOutbox();
    return doc;
  }

  /**
   * Tombstone the document and publish `document.deleted`, then remove its
   * blobs. Blob removal is retried by maintenance if it fails here.
   */
  async delete(
    tenantId: string,
    docId: string,
    options: { expectedVersion: number | null; correlationId: string },
  ): Promise<void> {
    const tombstone = await this.repo.markDeleted(tenantId, docId, {
      expectedVersion: options.expectedVersion,
      makeEvent: (d) => events.documentDeleted(d, { correlationId: options.correlationId }),
    });
    this.notifyOutbox();
    await this.deleteTombstoneBlobs(tombstone);
  }

  async applyExtractionResult(result: ExtractionResult): Promise<ResultOutcome> {
    const [outcome, doc] = await this.repo.applyExtractionResult(result);
    logger.info('extraction_result_applied', { doc_id: result.docId, status: result.status, outcome });
    if (outcome === ResultOutcome.TOMBSTONED && doc !== null) {
      // Deleted while extraction was running: remove the late result.
      await this.deleteTombstoneBlobs(doc);
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async get(tenantId: string, docId: string): Promise<Document> {
    const doc = await this.repo.get(tenantId, docId);
    if (doc === null) {
      throw new DocumentNotFoundError(docId);
    }
    return doc;
  }

  list(
    tenantId: string,
    options: { limit: number; cursor: PageCursor | null; status: DocumentStatus | null },
  ): Promise<DocumentPage> {
    return this.repo.listDocuments(tenantId, options);
  }

  async openContent(tenantId: string, docId: string): Promise<{ doc: Document; content: BlobStream }> {
    const doc = await this.get(tenantId, docId);
    return { doc, content: await this.storage.openStream(doc.rawBlob) };
  }

  async getText(tenantId: string, docId: string): Promise<{ doc: Document; text: string }> {
    const doc = await this.get(tenantId, docId);
    if (doc.status !== DocumentStatus.SUCCEEDED || doc.textBlob === null) {
      throw new TextNotAvailableError(`extracted text is not available (status: ${doc.status})`);
    }
    return { doc, text: await this.storage.readExtractedText(doc.textBlob) };
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /**
   * Retry blob removal for tombstones, then purge old tombstones and
   * published outbox rows.
   */
  async runMaintenance(options: {
    tombstoneRetentionMs: number;
    outboxRetentionMs: number;
    batchSize?: number;
  }): Promise<void> {
    for (const tombstone of await this.repo.listTombstonesWithBlobs(options.batchSize ?? 100)) {
      await this.deleteTombstoneBlobs(tombstone);
    }
    const now = Date.now();
    const purgedDocs = await this.repo.purgeTombstones(new Date(now - options.tombstoneRetentionMs));
    const purgedEvents = await this.repo.purgePublishedOutbox(new Date(now - options.outboxRetentionMs));
    if (purgedDocs || purgedEvents) {
      logger.info('maintenance_purged', { tombstones: purgedDocs, outbox_events: purgedEvents });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Runs after the tombstone is committed, so a failure here must not fail
   * the caller: it is logged and maintenance retries it later.
   */
  private async deleteTombstoneBlobs(tombstone: Document): Promise<void> {
    const refs = tombstone.textBlob ? [tombstone.rawBlob, tombstone.textBlob] : [tombstone.rawBlob];
    try {
      for (const ref of refs) {
        await this.storage.delete(ref);
      }
      await this.repo.markBlobsDeleted(tombstone.tenantId, tombstone.id, tombstone.version);
    } catch (error) {
      if (!(error instanceof StorageUnavailableError || error instanceof RepositoryUnavailableError)) {
        throw error;
      }
      logger.warn('tombstone_blob_cleanup_failed', { doc_id: tombstone.id }, error);
    }
  }

  /**
   * Compensating action when the catalog write fails. Failures are logged,
   * not raised: the caller is already reporting an error.
   */
  private async deleteBlobBestEffort(ref: BlobRef): Promise<void> {
    try {
      await this.storage.delete(ref);
    } catch (error) {
      if (!(error instanceof StorageUnavailableError)) {
        throw error;
      }
      logger.error('orphaned_blob_cleanup_failed', { blob_name: ref.name }, error);
    }
  }
}
