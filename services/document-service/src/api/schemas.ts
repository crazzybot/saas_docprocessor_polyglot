/**
 * HTTP request and response shapes. Responses use snake_case field names, the
 * same as the message contracts.
 */

import { z } from 'zod';

import {
  DOCUMENT_STATUSES,
  DocumentStatus,
  type Document,
  type DocumentChanges,
  type DocumentPage,
} from '../domain/models.js';
import { validationError } from './api-error.js';

export function documentPath(docId: string): string {
  return `/documents/${docId}`;
}

export interface DocumentLinks {
  self: string;
  content: string;
  /** Present once extraction has succeeded. */
  text: string | null;
}

export interface DocumentResponse {
  doc_id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  status: DocumentStatus;
  error: string | null;
  title: string | null;
  tags: string[];
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  extracted_at: string | null;
  links: DocumentLinks;
}

export function documentLinks(doc: Document): DocumentLinks {
  const base = documentPath(doc.id);
  return {
    self: base,
    content: `${base}/content`,
    text: doc.status === DocumentStatus.SUCCEEDED ? `${base}/text` : null,
  };
}

export function toDocumentResponse(doc: Document): DocumentResponse {
  return {
    doc_id: doc.id,
    tenant_id: doc.tenantId,
    filename: doc.filename,
    content_type: doc.contentType,
    size_bytes: doc.sizeBytes,
    status: doc.status,
    error: doc.error,
    title: doc.title,
    tags: [...doc.tags],
    metadata: { ...doc.metadata },
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
    extracted_at: doc.extractedAt?.toISOString() ?? null,
    links: documentLinks(doc),
  };
}

export interface DocumentListResponse {
  items: DocumentResponse[];
  /** Pass as `cursor` to fetch the next page; null on the last page. */
  next_cursor: string | null;
}

export function toDocumentListResponse(page: DocumentPage): DocumentListResponse {
  return {
    items: page.items.map(toDocumentResponse),
    next_cursor: page.nextCursor?.encode() ?? null,
  };
}

/** Response of the deprecated `POST /upload` (kept for existing clients). */
export interface UploadResponse {
  doc_id: string;
  tenant_id: string;
  filename: string;
  content_type: string;
  blob_url: string;
  status: string;
  links: DocumentLinks;
}

export function toUploadResponse(doc: Document, blobUrl: string): UploadResponse {
  return {
    doc_id: doc.id,
    tenant_id: doc.tenantId,
    filename: doc.filename,
    content_type: doc.contentType,
    blob_url: blobUrl,
    status: DocumentStatus.QUEUED,
    links: documentLinks(doc),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Parse `value` with `schema`, or throw a 422 locating each issue under `location`. */
export function parseRequest<T extends z.ZodType>(schema: T, value: unknown, location: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw validationError(
      result.error.issues.map((issue) => ({
        loc: [location, ...issue.path.map((part) => (typeof part === 'symbol' ? String(part) : part))],
        msg: issue.message,
        type: issue.code,
      })),
    );
  }
  return result.data;
}

const tag = z.string().trim().min(1).max(64);
const metadata = z
  .record(z.string().min(1).max(64), z.string().max(1024))
  .refine((value) => Object.keys(value).length <= 50, { message: 'at most 50 entries' });

/**
 * JSON merge-patch semantics: only fields present are changed; `null` clears
 * `title` and empties `tags` / `metadata`. Unknown fields are rejected.
 */
export const DocumentPatchSchema = z.strictObject({
  title: z.string().max(255).nullable().optional(),
  tags: z.array(tag).max(50).nullable().optional(),
  metadata: metadata.nullable().optional(),
});

export function toDocumentChanges(patch: z.output<typeof DocumentPatchSchema>): DocumentChanges {
  return {
    ...('title' in patch ? { title: patch.title ?? null } : {}),
    // De-duplicate while keeping the client's order.
    ...('tags' in patch ? { tags: [...new Set(patch.tags ?? [])] } : {}),
    ...('metadata' in patch ? { metadata: { ...(patch.metadata ?? {}) } } : {}),
  };
}

export function listQuerySchema(maxPageSize: number) {
  return z.object({
    limit: z.coerce.number().int().min(1).max(maxPageSize).optional(),
    cursor: z.string().max(512).optional(),
    status: z.enum(DOCUMENT_STATUSES as [DocumentStatus, ...DocumentStatus[]]).optional(),
  });
}

// Any 8-4-4-4-12 hex ID (not only RFC 9562 versions), like Python's uuid.UUID.
export const DocIdSchema = z.guid().transform((id) => id.toLowerCase());
