/**
 * Message contracts between the services, for TypeScript.
 *
 * The source of truth is contracts/schemas/*.schema.json. `generated/contracts.ts`
 * holds the types and schemas generated from them (`just contracts`); this
 * module validates messages against those schemas with Ajv and adds the
 * behaviour the schemas can't express (message IDs, blob-name resolution).
 * The Python services generate pydantic models from the same schemas.
 *
 * Evolution rules, so the services stay independently deployable:
 *   - Changes are additive only. Never rename or remove a field, and never
 *     change a field's meaning.
 *   - New fields get defaults. Readers ignore fields they don't know (the
 *     schemas allow additional properties), so an older reader can process a
 *     newer message and the other way round.
 */

import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import {
  documentUploadedEventSchema,
  extractionCompletedEventSchema,
  type DocumentUploadedEvent as DocumentUploadedEventInput,
  type ExtractionCompletedEvent as ExtractionCompletedEventInput,
} from './generated/contracts.js';

export { documentUploadedEventSchema, extractionCompletedEventSchema };
export type { DocumentUploadedEventInput, ExtractionCompletedEventInput };

/** A parsed `document.uploaded` event: every default filled in. */
export type DocumentUploadedEvent = Required<DocumentUploadedEventInput>;
/** A parsed completion event: every default filled in. */
export type ExtractionCompletedEvent = Required<ExtractionCompletedEventInput>;

/** Application properties as Service Bus messages carry them. */
export type ApplicationProperties = Record<string, string | number | boolean | Date | null>;

/** Raised when a message body does not satisfy its contract. */
export class ContractError extends Error {
  override readonly name = 'ContractError';
}

// ajv-formats is CommonJS with a default export; Node hands ESM importers the
// module.exports function itself.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020, formats: string[]) => Ajv2020;

const ajv = addFormats(
  // useDefaults fills each missing optional field with its schema default.
  new Ajv2020({ useDefaults: true, allErrors: true, allowUnionTypes: true, verbose: true }),
  ['date-time'],
);
const validateUploaded = ajv.compile<DocumentUploadedEvent>(documentUploadedEventSchema);
const validateCompleted = ajv.compile<ExtractionCompletedEventInput>(extractionCompletedEventSchema);

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => {
      // A `not` rule says nothing useful by itself; its schema describes what it rejects.
      const message =
        error.keyword === 'not'
          ? ((error.schema as { description?: string }).description ?? error.message)
          : error.message;
      return `${error.instancePath || '(root)'} ${message}`;
    })
    .join('; ');
}

function validated<T>(validate: ValidateFunction<T>, value: unknown, what: string): T {
  // Validation fills defaults in place, so work on a copy.
  const copy = structuredClone(value);
  if (!validate(copy)) {
    throw new ContractError(`invalid ${what}: ${describeErrors(validate.errors)}`);
  }
  return copy;
}

/**
 * Decode a received Service Bus message body into a JSON value.
 *
 * The SDK already JSON-decodes data-section bodies when it can; bodies that
 * arrive as a Buffer or string (e.g. from other SDKs) are decoded here.
 */
export function decodeMessageBody(body: unknown): unknown {
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return parseJson(Buffer.from(body).toString('utf8'));
  }
  if (typeof body === 'string') {
    return parseJson(body);
  }
  return body;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ContractError('message body is not valid JSON');
  }
}

/**
 * The decoded blob name from a blob URL in `container`, or null if the URL
 * does not point into that container.
 *
 * Blob URLs are percent-encoded, while the SDK expects the raw name (it
 * encodes it again when building request URLs), so the result is decoded.
 */
export function blobNameFromUrl(blobUrl: string, container: string): string | null {
  let path: string;
  try {
    path = new URL(blobUrl).pathname;
  } catch {
    return null;
  }
  const marker = `/${container}/`;
  const idx = path.indexOf(marker);
  if (idx === -1) {
    return null;
  }
  const encoded = path.slice(idx + marker.length);
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    name = encoded; // malformed escape: keep it verbatim, like Python's unquote
  }
  return name || null;
}

/** Where the worker writes a document's extraction result, within the results container. */
export function resultBlobName(tenantId: string, docId: string): string {
  return `${tenantId}/${docId}.json`;
}

// ---------------------------------------------------------------------------
// document.uploaded: document service -> `document-events` topic; forwarded
// to the `extraction-jobs` queue, where the worker reads it as its job.
// ---------------------------------------------------------------------------
export const DocumentUploadedEvents = {
  /** Validate and fill defaults; throws ContractError. */
  create(input: DocumentUploadedEventInput): DocumentUploadedEvent {
    return validated(validateUploaded, input, 'document.uploaded event');
  },

  parse(body: unknown): DocumentUploadedEvent {
    return validated(validateUploaded, decodeMessageBody(body), 'document.uploaded event');
  },

  messageId(event: DocumentUploadedEvent): string {
    return event.doc_id;
  },

  /**
   * The source blob's name: `blob_name`, or decoded from `blob_url`.
   * Throws ContractError if neither yields a name.
   */
  resolveBlobName(event: DocumentUploadedEvent, defaultContainer: string): string {
    if (event.blob_name) {
      return event.blob_name;
    }
    const container = event.blob_container ?? defaultContainer;
    const name = blobNameFromUrl(event.blob_url ?? '', container);
    if (name === null) {
      throw new ContractError(`could not locate container '${container}' in blob URL '${event.blob_url}'`);
    }
    return name;
  },
};

// ---------------------------------------------------------------------------
// Extraction completed: worker -> `extraction-results` topic.
// ---------------------------------------------------------------------------
export const ExtractionStatus = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
} as const;
export type ExtractionStatus = ExtractionCompletedEvent['status'];

function withCompletedAt(event: ExtractionCompletedEventInput): ExtractionCompletedEvent {
  return { ...event, completed_at: event.completed_at ?? new Date().toISOString() } as ExtractionCompletedEvent;
}

export const ExtractionCompletedEvents = {
  create(input: ExtractionCompletedEventInput): ExtractionCompletedEvent {
    return withCompletedAt(validated(validateCompleted, input, 'completion event'));
  },

  parse(body: unknown): ExtractionCompletedEvent {
    return withCompletedAt(validated(validateCompleted, decodeMessageBody(body), 'completion event'));
  },

  /**
   * Deterministic per (doc, status): with duplicate detection on the topic,
   * a redelivered job does not produce a second event.
   */
  messageId(event: ExtractionCompletedEvent): string {
    return `${event.doc_id}:${event.status}`;
  },

  applicationProperties(event: ExtractionCompletedEvent): ApplicationProperties {
    return { tenant_id: event.tenant_id, doc_id: event.doc_id, status: event.status };
  },

  /**
   * The result blob's name for a succeeded event (from the URL, falling back
   * to the worker's path convention); null for a failed one.
   */
  resultBlobName(event: ExtractionCompletedEvent, resultsContainer: string): string | null {
    if (event.status !== ExtractionStatus.SUCCEEDED) {
      return null;
    }
    const fromUrl = event.result_blob_url ? blobNameFromUrl(event.result_blob_url, resultsContainer) : null;
    return fromUrl ?? resultBlobName(event.tenant_id, event.doc_id);
  },
};
