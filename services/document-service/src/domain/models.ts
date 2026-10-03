/**
 * Domain model for the document catalog.
 *
 * Plain immutable records shared by the repository, the service layer and
 * the background tasks; the HTTP shapes live in `api/schemas.ts`.
 */

import { InvalidCursorError } from './errors.js';

export const DocumentStatus = {
  QUEUED: 'queued',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus];
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = Object.values(DocumentStatus);

export const EventType = {
  UPLOADED: 'document.uploaded',
  UPDATED: 'document.updated',
  DELETED: 'document.deleted',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

export interface BlobRef {
  readonly container: string;
  readonly name: string;
}

export interface Document {
  readonly id: string;
  readonly tenantId: string;
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly status: DocumentStatus;
  readonly rawBlob: BlobRef;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly error: string | null;
  readonly textBlob: BlobRef | null;
  readonly extractedAt: Date | null;
  readonly title: string | null;
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, string>>;
  /** Incremented on every change; exposed to clients as the ETag. */
  readonly version: number;
  /**
   * Set when the document is deleted. The row is kept as a tombstone so that
   * late extraction results can be recognised and cleaned up.
   */
  readonly deletedAt: Date | null;
}

/** Defaults for the optional parts of a new document. */
export function newDocument(
  fields: Pick<Document, 'id' | 'tenantId' | 'filename' | 'contentType' | 'sizeBytes' | 'rawBlob' | 'createdAt'>,
): Document {
  return {
    ...fields,
    status: DocumentStatus.QUEUED,
    updatedAt: fields.createdAt,
    error: null,
    textBlob: null,
    extractedAt: null,
    title: null,
    tags: [],
    metadata: {},
    version: 1,
    deletedAt: null,
  };
}

export function etagOf(doc: Pick<Document, 'version'>): string {
  return `"${doc.version}"`;
}

/**
 * A message to publish on the events topic, written in the same transaction
 * as the state change it describes.
 */
export interface OutboxEvent {
  readonly eventType: EventType;
  readonly messageId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly properties: Readonly<Record<string, string>>;
}

export interface OutboxRecord {
  readonly id: number;
  readonly event: OutboxEvent;
}

/**
 * User-editable fields from a PATCH. `undefined` means "leave unchanged"; an
 * explicit clear is `title: null` (and empty `tags` / `metadata`).
 */
export interface DocumentChanges {
  readonly title?: string | null;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, string>>;
}

export function isEmptyChanges(changes: DocumentChanges): boolean {
  return changes.title === undefined && changes.tags === undefined && changes.metadata === undefined;
}

export interface ExtractionResult {
  readonly tenantId: string;
  readonly docId: string;
  readonly status: DocumentStatus;
  readonly textBlob: BlobRef | null;
  readonly error: string | null;
  readonly completedAt: Date;
}

export const ResultOutcome = {
  APPLIED: 'applied',
  /** The document already has a terminal status (redelivered/duplicate event). */
  IGNORED: 'ignored',
  /** The document was deleted before extraction finished. */
  TOMBSTONED: 'tombstoned',
  /** No such document (e.g. uploaded before the catalog existed). */
  NOT_FOUND: 'not_found',
} as const;
export type ResultOutcome = (typeof ResultOutcome)[keyof typeof ResultOutcome];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Keyset position for newest-first listing: (createdAt, id) of the last item
 * on the previous page. Opaque to clients.
 *
 * Timestamps are written by this service with millisecond precision (JS
 * `Date`), so the cursor round-trips them exactly.
 */
export class PageCursor {
  constructor(
    readonly createdAt: Date,
    readonly docId: string,
  ) {}

  encode(): string {
    return Buffer.from(JSON.stringify({ c: this.createdAt.toISOString(), i: this.docId })).toString('base64url');
  }

  static decode(token: string): PageCursor {
    let data: unknown;
    try {
      data = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      throw new InvalidCursorError('malformed cursor');
    }
    const { c, i } = (data ?? {}) as { c?: unknown; i?: unknown };
    // Require an explicit offset: a naive timestamp would be read as local time.
    if (typeof c !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(c) || typeof i !== 'string' || !isUuid(i)) {
      throw new InvalidCursorError('malformed cursor');
    }
    const createdAt = new Date(c);
    if (Number.isNaN(createdAt.getTime())) {
      throw new InvalidCursorError('malformed cursor');
    }
    return new PageCursor(createdAt, i.toLowerCase());
  }
}

export interface DocumentPage {
  readonly items: readonly Document[];
  readonly nextCursor: PageCursor | null;
}
