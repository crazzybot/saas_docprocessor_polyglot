/** `BlobDocumentStorage` against a stubbed Azure SDK client. */

import { Readable } from 'node:stream';

import { RestError } from '@azure/core-rest-pipeline';
import type { BlobServiceClient } from '@azure/storage-blob';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BlobDocumentStorage } from '../src/adapters/blob-storage.js';
import { ContentMissingError, StorageUnavailableError } from '../src/domain/errors.js';

const REF = { container: 'raw-documents', name: 't/d/Отчёт.pdf' };

const notFound = () => new RestError('gone', { statusCode: 404 });

let blob: {
  url: string;
  uploadData: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  downloadToBuffer: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let storage: BlobDocumentStorage;

beforeEach(() => {
  blob = {
    url: 'https://acct.blob.core.windows.net/raw-documents/t/d/x.pdf',
    uploadData: vi.fn(async () => ({})),
    download: vi.fn(),
    downloadToBuffer: vi.fn(),
    delete: vi.fn(async () => ({})),
  };
  const client = { getContainerClient: () => ({ getBlockBlobClient: () => blob }) };
  storage = new BlobDocumentStorage(client as unknown as BlobServiceClient);
});

describe('BlobDocumentStorage', () => {
  it('percent-encodes metadata on upload', async () => {
    const url = await storage.upload(REF, Buffer.from('%PDF'), {
      contentType: 'application/pdf',
      metadata: { doc_id: 'd', original_filename: 'Отчёт.pdf' },
    });

    expect(url).toBe(blob.url);
    expect(blob.uploadData).toHaveBeenCalledWith(Buffer.from('%PDF'), {
      blobHTTPHeaders: { blobContentType: 'application/pdf' },
      metadata: { doc_id: 'd', original_filename: '%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf' },
    });
  });

  it('reports an upload failure as StorageUnavailableError', async () => {
    blob.uploadData.mockRejectedValue(new RestError('network down', { code: 'REQUEST_SEND_ERROR' }));
    await expect(
      storage.upload(REF, Buffer.from('x'), { contentType: 'application/pdf', metadata: {} }),
    ).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('reports a missing blob as ContentMissingError', async () => {
    blob.download.mockRejectedValue(notFound());
    blob.downloadToBuffer.mockRejectedValue(notFound());
    await expect(storage.openStream(REF)).rejects.toBeInstanceOf(ContentMissingError);
    await expect(storage.readExtractedText(REF)).rejects.toBeInstanceOf(ContentMissingError);
  });

  it('opens a stream with its size', async () => {
    const body = Readable.from([Buffer.from('%PDF')]);
    blob.download.mockResolvedValue({ contentLength: 4, readableStreamBody: body });
    expect(await storage.openStream(REF)).toEqual({ size: 4, stream: body });
  });

  it('reads the extracted text', async () => {
    blob.downloadToBuffer.mockResolvedValue(Buffer.from(JSON.stringify({ extracted_text: 'héllo' })));
    expect(await storage.readExtractedText(REF)).toBe('héllo');
  });

  it('deletes idempotently', async () => {
    blob.delete.mockRejectedValue(notFound());
    await expect(storage.delete(REF)).resolves.toBeUndefined();
    blob.delete.mockRejectedValue(new RestError('throttled', { statusCode: 503 }));
    await expect(storage.delete(REF)).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
