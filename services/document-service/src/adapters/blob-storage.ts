/** Azure Blob Storage implementation of the `DocumentStorage` port. */

import type { Readable } from 'node:stream';

import { azureStatusCode, errorMessage, getLogger } from '@docprocessor/shared';
import type { BlobServiceClient } from '@azure/storage-blob';

import type { BlobStream, DocumentStorage } from '../application/ports.js';
import { ContentMissingError, StorageUnavailableError } from '../domain/errors.js';
import type { BlobRef } from '../domain/models.js';

const logger = getLogger('document_service.adapters.blob_storage');

function unavailable(action: string, error: unknown): StorageUnavailableError {
  return new StorageUnavailableError(`${action} failed: ${errorMessage(error)}`, { cause: error });
}

export class BlobDocumentStorage implements DocumentStorage {
  constructor(private readonly client: BlobServiceClient) {}

  private blob(ref: BlobRef) {
    return this.client.getContainerClient(ref.container).getBlockBlobClient(ref.name);
  }

  /**
   * Upload bytes and return the blob URL. Metadata travels as HTTP headers
   * and must be ASCII, so values are percent-encoded.
   */
  async upload(
    ref: BlobRef,
    data: Buffer,
    options: { contentType: string; metadata: Readonly<Record<string, string>> },
  ): Promise<string> {
    const blob = this.blob(ref);
    const metadata = Object.fromEntries(
      Object.entries(options.metadata).map(([key, value]) => [key, encodeURIComponent(value)]),
    );
    try {
      await blob.uploadData(data, { blobHTTPHeaders: { blobContentType: options.contentType }, metadata });
    } catch (error) {
      throw unavailable('upload', error);
    }
    return blob.url;
  }

  /**
   * Start a download. The first response is awaited here so that a missing
   * blob or an outage surfaces before the HTTP response starts.
   */
  async openStream(ref: BlobRef): Promise<BlobStream> {
    try {
      const response = await this.blob(ref).download();
      const stream = response.readableStreamBody as Readable | undefined;
      if (!stream) {
        throw new Error('download returned no body');
      }
      return { size: response.contentLength ?? 0, stream };
    } catch (error) {
      if (azureStatusCode(error) === 404) {
        throw new ContentMissingError(ref.name, { cause: error });
      }
      throw unavailable('download', error);
    }
  }

  /** Read the worker's result JSON and return its `extracted_text`. */
  async readExtractedText(ref: BlobRef): Promise<string> {
    let data: Buffer;
    try {
      data = await this.blob(ref).downloadToBuffer();
    } catch (error) {
      if (azureStatusCode(error) === 404) {
        throw new ContentMissingError(ref.name, { cause: error });
      }
      throw unavailable('download', error);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data.toString('utf8'));
    } catch (error) {
      throw new ContentMissingError(`result blob is not valid JSON: ${ref.name}`, { cause: error });
    }
    const text = (payload as { extracted_text?: unknown } | null)?.extracted_text;
    return typeof text === 'string' ? text : '';
  }

  /** Idempotent: deleting a blob that is already gone succeeds. */
  async delete(ref: BlobRef): Promise<void> {
    try {
      await this.blob(ref).delete();
    } catch (error) {
      if (azureStatusCode(error) === 404) {
        logger.debug('blob_already_deleted', { blob: ref.name });
        return;
      }
      throw unavailable('delete', error);
    }
  }

  async ping(container: string): Promise<void> {
    try {
      await this.client.getContainerClient(container).exists();
    } catch (error) {
      throw unavailable('ping', error);
    }
  }
}
