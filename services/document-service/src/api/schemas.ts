/**
 * HTTP request and response shapes. Responses use snake_case field names, the
 * same as the message contracts.
 *
 * Every shape is a zod schema, and `openapi.ts` builds the published OpenAPI
 * document from them. Response schemas are strict so the API tests can check
 * that responses carry no undocumented fields; the published document leaves
 * them open, since clients must ignore fields they don't know.
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

const DocumentStatusSchema = z.enum(DOCUMENT_STATUSES as [DocumentStatus, ...DocumentStatus[]]);

export const DocumentLinksSchema = z.strictObject({
  self: z.string(),
  content: z.string(),
  text: z.string().nullable().describe('Present once extraction has succeeded.'),
});
export type DocumentLinks = z.output<typeof DocumentLinksSchema>;

export const DocumentResponseSchema = z.strictObject({
  doc_id: z.string(),
  tenant_id: z.string(),
  filename: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  status: DocumentStatusSchema,
  error: z.string().nullable().describe('Why extraction failed; set only when status is failed.'),
  title: z.string().nullable(),
  tags: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  extracted_at: z.iso.datetime().nullable(),
  links: DocumentLinksSchema,
});
export type DocumentResponse = z.output<typeof DocumentResponseSchema>;

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

export const DocumentListResponseSchema = z.strictObject({
  items: z.array(DocumentResponseSchema),
  next_cursor: z.string().nullable().describe('Pass as `cursor` to fetch the next page; null on the last page.'),
});
export type DocumentListResponse = z.output<typeof DocumentListResponseSchema>;

export function toDocumentListResponse(page: DocumentPage): DocumentListResponse {
  return {
    items: page.items.map(toDocumentResponse),
    next_cursor: page.nextCursor?.encode() ?? null,
  };
}

export const UploadResponseSchema = z
  .strictObject({
    doc_id: z.string(),
    tenant_id: z.string(),
    filename: z.string(),
    content_type: z.string(),
    blob_url: z.string(),
    status: DocumentStatusSchema,
    links: DocumentLinksSchema,
  })
  .describe('Response of the deprecated `POST /upload` (kept for existing clients).');
export type UploadResponse = z.output<typeof UploadResponseSchema>;

/** Every error body except a 422's. */
export const ErrorResponseSchema = z.strictObject({ detail: z.string() });

/** A 422: every issue found in the request. */
export const ValidationErrorResponseSchema = z.strictObject({
  detail: z.array(
    z.strictObject({
      loc: z
        .array(z.union([z.string(), z.number()]))
        .describe('Where the issue is: `body`, `query` or `path`, then the field.'),
      msg: z.string(),
      type: z.string(),
    }),
  ),
});

export const ProbeResponseSchema = z.strictObject({ status: z.string() });

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
  .refine((value) => Object.keys(value).length <= 50, { message: 'at most 50 entries' })
  // The refinement above, for the OpenAPI document.
  .meta({ maxProperties: 50 });

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
    status: DocumentStatusSchema.optional(),
  });
}

// Any 8-4-4-4-12 hex ID (not only RFC 9562 versions), like Python's uuid.UUID.
export const DocIdSchema = z.guid().transform((id) => id.toLowerCase());
