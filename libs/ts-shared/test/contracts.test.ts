/**
 * The TypeScript contract layer against the golden messages in
 * contracts/examples. The Python tests run the same examples through the
 * generated pydantic models, so both languages agree on what is valid.
 */

import { describe, expect, it } from 'vitest';

import {
  ContractError,
  DocumentUploadedEvents,
  ExtractionCompletedEvents,
  documentUploadedEventSchema,
  extractionCompletedEventSchema,
} from '../src/index.js';
import { examples } from './examples.js';

describe('document.uploaded', () => {
  it.each(examples('document-uploaded', 'valid'))('accepts %s, filling defaults', (_name, body) => {
    const event = DocumentUploadedEvents.parse(Buffer.from(JSON.stringify(body)));
    expect(event.event_type).toBe('document.uploaded');
    for (const field of Object.keys(documentUploadedEventSchema.properties)) {
      expect(event).toHaveProperty(field);
    }
    expect(DocumentUploadedEvents.resolveBlobName(event, 'raw-documents')).not.toBe('');
  });

  it.each(examples('document-uploaded', 'invalid'))('rejects %s', (_name, body) => {
    expect(() => DocumentUploadedEvents.parse(body)).toThrow(ContractError);
  });

  it('explains the location rule', () => {
    expect(() => DocumentUploadedEvents.parse({ doc_id: 'd', tenant_id: 't', content_type: 'x' })).toThrow(
      /Neither blob_name nor blob_url is set/,
    );
  });

  it('decodes a legacy blob_url', () => {
    const [, legacy] = examples('document-uploaded', 'valid').find(([name]) => name === 'legacy-blob-url-only.json')!;
    expect(DocumentUploadedEvents.resolveBlobName(DocumentUploadedEvents.parse(legacy), 'raw-documents')).toBe(
      't/d/my report.pdf',
    );
  });
});

describe('extraction completed', () => {
  it.each(examples('extraction-completed', 'valid'))('accepts %s', (_name, body) => {
    const event = ExtractionCompletedEvents.parse(body);
    expect(Number.isNaN(Date.parse(event.completed_at))).toBe(false);
  });

  it.each(examples('extraction-completed', 'invalid'))('rejects %s', (_name, body) => {
    expect(() => ExtractionCompletedEvents.parse(body)).toThrow(ContractError);
  });

  it('builds message IDs and properties from the event', () => {
    const event = ExtractionCompletedEvents.create({ doc_id: 'd', tenant_id: 't', status: 'failed', error: 'x' });
    expect(ExtractionCompletedEvents.messageId(event)).toBe('d:failed');
    expect(ExtractionCompletedEvents.applicationProperties(event)).toEqual({
      tenant_id: 't',
      doc_id: 'd',
      status: 'failed',
    });
    expect(ExtractionCompletedEvents.resultBlobName(event, 'extraction-results')).toBeNull();
  });
});

describe('wire field names', () => {
  it('stay stable', () => {
    // Renaming or removing a field breaks consumers that are already
    // deployed. Adding one is fine: extend these lists in the same change.
    expect(Object.keys(documentUploadedEventSchema.properties).sort()).toEqual(
      [
        'event_type',
        'doc_id',
        'tenant_id',
        'content_type',
        'filename',
        'size_bytes',
        'blob_name',
        'blob_url',
        'blob_container',
        'correlation_id',
        'submitted_at',
      ].sort(),
    );
    expect(Object.keys(extractionCompletedEventSchema.properties).sort()).toEqual(
      ['doc_id', 'tenant_id', 'status', 'result_blob_url', 'error', 'completed_at'].sort(),
    );
  });
});
