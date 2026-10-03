/**
 * The document service's side of the cross-language contracts: it consumes
 * every golden completion event (as the Python worker produces them) and
 * produces document.uploaded events that satisfy the shared schema.
 */

import { readdirSync, readFileSync } from 'node:fs';

import { DocumentUploadedEvents } from '@docprocessor/shared';
import { describe, expect, it } from 'vitest';

import { toServiceBusMessage } from '../src/adapters/service-bus/outbox-relay.js';
import { InvalidEventError, parseResultEvent } from '../src/adapters/service-bus/results-consumer.js';
import { documentUploaded } from '../src/domain/events.js';
import { newDocument } from '../src/domain/models.js';

const RESULTS = 'extraction-results';

function examples(kind: 'valid' | 'invalid'): [string, unknown][] {
  const dir = new URL(`../../../contracts/examples/extraction-completed/${kind}/`, import.meta.url);
  return readdirSync(dir)
    .sort()
    .map((name) => [name, JSON.parse(readFileSync(new URL(name, dir), 'utf8')) as unknown]);
}

describe('consuming extraction-completed', () => {
  it.each(examples('valid'))('applies %s', (_name, body) => {
    // Delivered as UTF-8 JSON in the AMQP data section, as the Python SDK sends it.
    const result = parseResultEvent(Buffer.from(JSON.stringify(body)), { resultsContainer: RESULTS });
    expect(result.textBlob === null).toBe(result.status === 'failed');
  });

  it.each(examples('invalid'))('dead-letters %s', (_name, body) => {
    expect(() => parseResultEvent(body, { resultsContainer: RESULTS })).toThrow(InvalidEventError);
  });
});

describe('producing document.uploaded', () => {
  it('sends a body the worker contract accepts', () => {
    const doc = newDocument({
      id: '6f1c2a9e-8f3b-4c1d-9e2a-0b7d5c3e1f40',
      tenantId: 't',
      filename: 'a.pdf',
      contentType: 'application/pdf',
      sizeBytes: 8,
      rawBlob: { container: 'raw-documents', name: 't/6f1c2a9e-8f3b-4c1d-9e2a-0b7d5c3e1f40/a.pdf' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const message = toServiceBusMessage({
      id: 1,
      event: documentUploaded(doc, { blobUrl: 'https://acct/raw-documents/x', correlationId: 'c', traceContext: {} }),
    });
    // Round-trip through JSON, as the broker delivers it.
    const event = DocumentUploadedEvents.parse(JSON.parse(JSON.stringify(message.body)));
    expect(event).toMatchObject({ doc_id: doc.id, blob_name: doc.rawBlob.name, size_bytes: 8 });
    expect(message.messageId).toBe(doc.id);
    expect(message.applicationProperties).toMatchObject({ event_type: 'document.uploaded' });
  });
});
