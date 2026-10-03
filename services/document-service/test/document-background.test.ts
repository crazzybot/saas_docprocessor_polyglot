import type { ServiceBusMessage, ServiceBusMessageBatch } from '@azure/service-bus';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OutboxRelay, type EventSender } from '../src/adapters/service-bus/outbox-relay.js';
import {
  ExtractionResultsConsumer,
  InvalidEventError,
  parseResultEvent,
  type ReceivedMessage,
  type ResultsReceiver,
} from '../src/adapters/service-bus/results-consumer.js';
import { runMaintenanceLoop } from '../src/application/maintenance.js';
import { RepositoryUnavailableError } from '../src/domain/errors.js';
import { DocumentStatus, EventType, ResultOutcome } from '../src/domain/models.js';
import { createBackend, PDF_BYTES, TEST_TENANT_ID, type Backend } from './support.js';

const RESULTS = 'extraction-results';

let backend: Backend;

beforeEach(() => {
  backend = createBackend();
});

async function uploadDoc(): Promise<string> {
  const { doc } = await backend.service.upload({
    tenantId: TEST_TENANT_ID,
    filename: 'a.pdf',
    contentType: 'application/pdf',
    data: PDF_BYTES,
    correlationId: 'corr-1',
    traceContext: {},
  });
  return doc.id;
}

function eventBody(docId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    doc_id: docId,
    tenant_id: TEST_TENANT_ID,
    status: 'succeeded',
    result_blob_url: `https://acct.blob.core.windows.net/${RESULTS}/${TEST_TENANT_ID}/${docId}.json`,
    error: null,
    completed_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function apply(docId: string, overrides: Record<string, unknown> = {}) {
  return backend.service.applyExtractionResult(
    parseResultEvent(eventBody(docId, overrides), { resultsContainer: RESULTS }),
  );
}

// ---------------------------------------------------------------------------
// Applying results
// ---------------------------------------------------------------------------
describe('extraction results', () => {
  it('move queued to succeeded', async () => {
    const docId = await uploadDoc();
    expect(await apply(docId)).toBe(ResultOutcome.APPLIED);
    const doc = backend.repo.docs.get(docId);
    expect(doc?.status).toBe(DocumentStatus.SUCCEEDED);
    expect(doc?.textBlob).toEqual({ container: RESULTS, name: `${TEST_TENANT_ID}/${docId}.json` });
    expect(doc?.version).toBe(2);
  });

  it('ignore duplicate or conflicting results', async () => {
    const docId = await uploadDoc();
    await apply(docId);
    expect(await apply(docId)).toBe(ResultOutcome.IGNORED);
    expect(await apply(docId, { status: 'failed', error: 'late' })).toBe(ResultOutcome.IGNORED);
    expect(backend.repo.docs.get(docId)?.status).toBe(DocumentStatus.SUCCEEDED);
  });

  it('record the error of a failure', async () => {
    const docId = await uploadDoc();
    await apply(docId, { status: 'failed', error: 'corrupt file', result_blob_url: null });
    const doc = backend.repo.docs.get(docId);
    expect(doc).toMatchObject({ status: DocumentStatus.FAILED, error: 'corrupt file', textBlob: null });
  });

  it('remove a late result blob after delete', async () => {
    const docId = await uploadDoc();
    await backend.service.delete(TEST_TENANT_ID, docId, { expectedVersion: null, correlationId: 'c' });
    const resultBlob = { container: RESULTS, name: `${TEST_TENANT_ID}/${docId}.json` };
    backend.storage.put(resultBlob, '{"extracted_text": "late"}');

    expect(await apply(docId)).toBe(ResultOutcome.TOMBSTONED);
    expect(backend.storage.has(resultBlob)).toBe(false);
    expect(backend.repo.blobsDeleted.get(docId)).toBe(true);
  });

  it('ignore results for unknown documents', async () => {
    expect(await apply('9f0f1c1e-0000-4000-8000-000000000000')).toBe(ResultOutcome.NOT_FOUND);
  });
});

describe('parseResultEvent', () => {
  it('reads the blob name from the URL', () => {
    const result = parseResultEvent(
      eventBody('d1', { result_blob_url: `https://acct.blob.core.windows.net/${RESULTS}/t/sub%20dir/d1.json` }),
      { resultsContainer: RESULTS },
    );
    expect(result.textBlob).toEqual({ container: RESULTS, name: 't/sub dir/d1.json' });
  });

  it('falls back to the deterministic name', () => {
    const result = parseResultEvent(eventBody('d1', { result_blob_url: null }), { resultsContainer: RESULTS });
    expect(result.textBlob?.name).toBe(`${TEST_TENANT_ID}/d1.json`);
  });

  it('gives a failed event no text blob', () => {
    const result = parseResultEvent(eventBody('d1', { status: 'failed', error: 'x' }), { resultsContainer: RESULTS });
    expect(result.textBlob).toBeNull();
    expect(result.status).toBe(DocumentStatus.FAILED);
  });

  it.each([
    'not json',
    JSON.stringify({ doc_id: 'd1' }),
    JSON.stringify({ doc_id: 'd1', tenant_id: 't', status: 'unknown' }),
    JSON.stringify({ doc_id: '', tenant_id: 't', status: 'failed' }),
  ])('rejects malformed events: %s', (body) => {
    expect(() => parseResultEvent(body, { resultsContainer: RESULTS })).toThrow(InvalidEventError);
  });
});

// ---------------------------------------------------------------------------
// Consumer message settlement
// ---------------------------------------------------------------------------
function consumer(): ExtractionResultsConsumer {
  return new ExtractionResultsConsumer(backend.service, () => receiver(), {
    resultsContainer: RESULTS,
    maxWaitTimeMs: 10,
    maxDeliveryAttempts: 3,
  });
}

function message(body: unknown, deliveryCount = 1): ReceivedMessage {
  return { body, deliveryCount, correlationId: 'corr-1' };
}

function receiver() {
  return {
    receiveMessages: vi.fn(async () => []),
    completeMessage: vi.fn(async () => undefined),
    abandonMessage: vi.fn(async () => undefined),
    deadLetterMessage: vi.fn(async (_message: unknown, _options?: Record<string, unknown>) => undefined),
    close: vi.fn(async () => undefined),
  } satisfies ResultsReceiver;
}

describe('results consumer', () => {
  it('completes a processed message', async () => {
    const docId = await uploadDoc();
    const r = receiver();
    const m = message(eventBody(docId));
    await consumer().handle(r, m);
    expect(r.completeMessage).toHaveBeenCalledWith(m);
    expect(backend.repo.docs.get(docId)?.status).toBe(DocumentStatus.SUCCEEDED);
  });

  it('dead-letters a malformed message', async () => {
    const r = receiver();
    await consumer().handle(r, message(Buffer.from('not json')));
    expect(r.deadLetterMessage).toHaveBeenCalledOnce();
    expect(r.deadLetterMessage.mock.calls[0]?.[1]).toMatchObject({ deadLetterReason: 'InvalidEvent' });
  });

  it('abandons on a database outage, then dead-letters', async () => {
    const docId = await uploadDoc();
    backend.repo.failWith = new RepositoryUnavailableError('db down');
    const c = consumer();

    const first = receiver();
    await c.handle(first, message(eventBody(docId), 1));
    const last = receiver();
    await c.handle(last, message(eventBody(docId), 3));

    expect(first.abandonMessage).toHaveBeenCalledOnce();
    expect(last.deadLetterMessage).toHaveBeenCalledOnce();
    expect(last.deadLetterMessage.mock.calls[0]?.[1]).toMatchObject({
      deadLetterReason: 'MaxDeliveryAttemptsExceeded',
    });
  });

  it('reconnects after the receiver fails, and stops on abort', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const receivers: ReturnType<typeof receiver>[] = [];
      const c = new ExtractionResultsConsumer(
        backend.service,
        () => {
          const r = receiver();
          if (receivers.length === 0) {
            r.receiveMessages.mockRejectedValueOnce(new Error('link detached'));
          } else {
            r.receiveMessages.mockImplementation(async () => {
              abort.abort();
              return [];
            });
          }
          receivers.push(r);
          return r;
        },
        { resultsContainer: RESULTS, maxWaitTimeMs: 10, maxDeliveryAttempts: 3 },
      );
      const running = c.run(abort.signal);
      await vi.advanceTimersByTimeAsync(5_000);
      await running;
      expect(receivers).toHaveLength(2);
      expect(receivers.every((r) => r.close.mock.calls.length === 1)).toBe(true);
      expect(c.connected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Outbox relay
// ---------------------------------------------------------------------------
interface FakeSender extends EventSender {
  sent: ServiceBusMessage[][];
}

function sender(options: { capacity?: number; failWith?: Error } = {}): FakeSender {
  const sent: ServiceBusMessage[][] = [];
  return {
    sent,
    createMessageBatch: vi.fn(async () => {
      const messages: ServiceBusMessage[] = [];
      return {
        messages,
        get count() {
          return messages.length;
        },
        tryAddMessage(m: ServiceBusMessage) {
          if (messages.length >= (options.capacity ?? Number.POSITIVE_INFINITY)) {
            return false;
          }
          messages.push(m);
          return true;
        },
      } as unknown as ServiceBusMessageBatch;
    }),
    sendMessages: vi.fn(async (batch: unknown) => {
      if (options.failWith) {
        throw options.failWith;
      }
      sent.push([...(batch as { messages: ServiceBusMessage[] }).messages]);
    }),
  };
}

describe('outbox relay', () => {
  const relay = (s: EventSender, batchSize = 10) => new OutboxRelay(backend.repo, s, { batchSize, pollIntervalMs: 10 });

  it('publishes pending events once', async () => {
    const docId = await uploadDoc();
    const s = sender();
    const r = relay(s);
    expect(await r.publishPending()).toBe(1);
    expect(await r.publishPending()).toBe(0);

    const [[m]] = s.sent as [[ServiceBusMessage]];
    expect(m.messageId).toBe(docId);
    expect(m.correlationId).toBe('corr-1');
    expect(m.contentType).toBe('application/json');
    expect(m.applicationProperties?.event_type).toBe(EventType.UPLOADED);
    expect((m.body as { blob_name: string }).blob_name).toBe(`${TEST_TENANT_ID}/${docId}/a.pdf`);
  });

  it('drains in batches', async () => {
    for (let i = 0; i < 5; i++) {
      await uploadDoc();
    }
    const s = sender();
    expect(await relay(s, 2).publishPending()).toBe(5);
    expect(s.sent.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it('keeps events when the send fails', async () => {
    await uploadDoc();
    const error = Object.assign(new Error('broker down'), { name: 'ServiceBusError' });
    await expect(relay(sender({ failWith: error })).publishPending()).rejects.toBe(error);
    expect(backend.repo.outbox.map((entry) => entry.publishedAt)).toEqual([null]);
  });

  it('splits the batch when a message batch is full', async () => {
    for (let i = 0; i < 3; i++) {
      await uploadDoc();
    }
    const s = sender({ capacity: 2 });
    await relay(s).publishPending();
    expect(s.sent.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it('is woken by notify instead of waiting for the poll', async () => {
    const s = sender();
    const abort = new AbortController();
    const r = new OutboxRelay(backend.repo, s, { batchSize: 10, pollIntervalMs: 60_000 });
    const running = r.run(abort.signal);
    await uploadDoc();
    r.notify();
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    abort.abort();
    await running;
  });
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------
describe('maintenance', () => {
  it('retries blob cleanup and purges', async () => {
    const docId = await uploadDoc();
    backend.storage.failDeletes = true;
    await backend.service.delete(TEST_TENANT_ID, docId, { expectedVersion: null, correlationId: 'c' });
    expect(backend.storage.blobs.size).toBe(1); // the delete left the raw blob behind
    backend.storage.failDeletes = false;

    await backend.service.runMaintenance({ tombstoneRetentionMs: 3_600_000, outboxRetentionMs: 3_600_000 });
    expect(backend.storage.blobs.size).toBe(0);
    expect(backend.repo.docs.has(docId)).toBe(true); // still within retention

    await new Promise((resolve) => setTimeout(resolve, 2));
    await backend.service.runMaintenance({ tombstoneRetentionMs: 0, outboxRetentionMs: 3_600_000 });
    expect(backend.repo.docs.has(docId)).toBe(false);
  });

  it('keeps looping after a failure', async () => {
    vi.useFakeTimers();
    try {
      const abort = new AbortController();
      const run = vi
        .spyOn(backend.service, 'runMaintenance')
        .mockRejectedValueOnce(new RepositoryUnavailableError('down'))
        .mockResolvedValue(undefined);
      const loop = runMaintenanceLoop(backend.service, {
        intervalMs: 1_000,
        tombstoneRetentionMs: 0,
        outboxRetentionMs: 0,
        signal: abort.signal,
      });
      await vi.advanceTimersByTimeAsync(2_500);
      expect(run).toHaveBeenCalledTimes(2);
      abort.abort();
      await loop;
    } finally {
      vi.useRealTimers();
    }
  });
});
