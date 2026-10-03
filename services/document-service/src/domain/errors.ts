/**
 * Errors raised by the repository and service layers.
 *
 * The API maps them to HTTP status codes in one place
 * (`api/error.filter.ts`), so the lower layers stay free of HTTP concerns.
 */

/** Base class for errors raised by the document service layers. */
export class DocumentServiceError extends Error {
  override name = this.constructor.name;
}

/** No live document with this ID exists for the tenant. */
export class DocumentNotFoundError extends DocumentServiceError {}

/** The client's If-Match version does not match the current version. */
export class VersionConflictError extends DocumentServiceError {
  constructor(readonly currentVersion: number) {
    super(`document has changed (current version ${currentVersion})`);
  }
}

/** Extracted text was requested for a document that has none (yet). */
export class TextNotAvailableError extends DocumentServiceError {}

/** The catalog references a blob that no longer exists in storage. */
export class ContentMissingError extends DocumentServiceError {}

/** The catalog database could not be reached or the statement failed. */
export class RepositoryUnavailableError extends DocumentServiceError {}

/** Blob Storage could not be reached. */
export class StorageUnavailableError extends DocumentServiceError {}

/** A client supplied a page cursor this service did not issue. */
export class InvalidCursorError extends DocumentServiceError {}
