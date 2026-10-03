import { RestError } from '@azure/core-rest-pipeline';
import type { BlobServiceClient } from '@azure/storage-blob';
import { context, propagation, trace, TraceFlags } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  azureServiceSettings,
  ensureContainer,
  envName,
  extractTraceContext,
  getLogger,
  isTransientAzureError,
  loadSettings,
  logRecordAttributes,
  NestJsonLogger,
  runWithCorrelationId,
  setLogWriter,
  sleep,
  WakeSignal,
  withTimeout,
} from '../src/index.js';

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

function containerClient(options: { exists: boolean; createError?: Error }) {
  const container = {
    exists: vi.fn(async () => options.exists),
    create: vi.fn(async () => {
      if (options.createError) {
        throw options.createError;
      }
      return {};
    }),
  };
  return { container, client: { getContainerClient: () => container } as unknown as BlobServiceClient };
}

describe('ensureContainer', () => {
  it('creates a missing container', async () => {
    const { container, client } = containerClient({ exists: false });
    await ensureContainer(client, 'results');
    expect(container.create).toHaveBeenCalledOnce();
  });

  it('tolerates losing the create race', async () => {
    const { client } = containerClient({ exists: false, createError: new RestError('exists', { statusCode: 409 }) });
    await expect(ensureContainer(client, 'results')).resolves.toBeUndefined();
  });

  it('skips an existing container', async () => {
    const { container, client } = containerClient({ exists: true });
    await ensureContainer(client, 'results');
    expect(container.create).not.toHaveBeenCalled();
  });

  it('propagates other failures', async () => {
    const { client } = containerClient({ exists: false, createError: new RestError('denied', { statusCode: 403 }) });
    await expect(ensureContainer(client, 'results')).rejects.toThrow('denied');
  });
});

describe('isTransientAzureError', () => {
  it('recognises SDK and network errors, not bugs', () => {
    expect(isTransientAzureError(new RestError('x'))).toBe(true);
    expect(isTransientAzureError(Object.assign(new Error('x'), { name: 'ServiceBusError' }))).toBe(true);
    expect(isTransientAzureError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientAzureError(new TypeError('undefined is not a function'))).toBe(false);
  });
});

describe('telemetry', () => {
  it('extracts a trace context from Buffer-valued properties', () => {
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    try {
      const ctx = extractTraceContext({ traceparent: Buffer.from(TRACEPARENT) });
      const spanContext = trace.getSpanContext(ctx);
      expect(spanContext?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
      expect(spanContext?.spanId).toBe('b7ad6b7169203331');
    } finally {
      propagation.disable();
    }
  });

  it('flattens structured fields into OTLP log attributes', () => {
    const attributes = logRecordAttributes({
      timestamp: new Date(),
      level: 'INFO',
      logger: 'x',
      message: 'm',
      correlationId: 'corr-1',
      fields: { doc_id: 'd1', count: 3, ok: true, nested: { a: 1 }, missing: null },
      error: new Error('boom'),
    });
    expect(attributes).toMatchObject({
      correlation_id: 'corr-1',
      doc_id: 'd1',
      count: 3,
      ok: true,
      nested: '{"a":1}',
    });
    expect(attributes).not.toHaveProperty('missing');
    expect(String(attributes['exception.stacktrace'])).toContain('boom');
  });
});

describe('logging', () => {
  let lines: string[] = [];
  let restore = () => {};

  afterEach(() => {
    restore();
    lines = [];
  });

  function capture(): void {
    restore = setLogWriter((line) => lines.push(line));
  }

  it('writes one JSON object per line with the correlation and trace IDs', () => {
    capture();
    const spanContext = {
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: TraceFlags.SAMPLED,
    };
    const ctx = trace.setSpanContext(context.active(), spanContext);
    runWithCorrelationId('corr-9', () => {
      context.with(ctx, () => getLogger('test').warn('thing_happened', { doc_id: 'd1' }, new Error('why')));
    });
    const payload = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      level: 'WARNING',
      logger: 'test',
      message: 'thing_happened',
      correlation_id: 'corr-9',
      doc_id: 'd1',
    });
    expect(payload.exception).toContain('why');
    expect(new Date(payload.timestamp as string).getTime()).not.toBeNaN();
  });

  it('defaults the correlation ID and filters below the level', () => {
    capture();
    getLogger('test').debug('hidden');
    getLogger('test').info('shown');
    expect(lines.map((line) => JSON.parse(line) as { message: string; correlation_id: string })).toEqual([
      expect.objectContaining({ message: 'shown', correlation_id: '-' }),
    ]);
  });

  it('routes Nest logs with their context', () => {
    capture();
    new NestJsonLogger().log('Mapped {/documents, GET} route', 'RouterExplorer');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      logger: 'nest',
      message: 'Mapped {/documents, GET} route',
      context: 'RouterExplorer',
    });
  });
});

describe('settings', () => {
  it('maps field names to environment variables', () => {
    expect(envName('maxConcurrency')).toBe('MAX_CONCURRENCY');
    expect(envName('azureAdJwksUrl')).toBe('AZURE_AD_JWKS_URL');
    expect(envName('otelServiceName')).toBe('OTEL_SERVICE_NAME');
  });

  it('reads the shared Azure base, treating empty variables as unset', () => {
    const settings = loadSettings(
      { ...azureServiceSettings, maxConcurrency: z.coerce.number().int().min(1).default(4) },
      { BLOB_CONTAINER_NAME: 'docs', STORAGE_ACCOUNT_URL: '', MAX_CONCURRENCY: '8' },
    );
    expect(settings).toMatchObject({
      blobContainerName: 'docs',
      resultsContainerName: 'extraction-results',
      maxConcurrency: 8,
    });
    expect(settings.storageAccountUrl).toBeUndefined();
  });

  it('names the offending variable', () => {
    expect(() => loadSettings({ maxConcurrency: z.coerce.number().int().min(1) }, { MAX_CONCURRENCY: '0' })).toThrow(
      /MAX_CONCURRENCY/,
    );
  });
});

describe('async helpers', () => {
  it('sleep returns early on abort', async () => {
    const abort = new AbortController();
    const started = performance.now();
    const sleeping = sleep(10_000, abort.signal);
    abort.abort();
    await sleeping;
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('WakeSignal wakes on notify, and remembers a notify before wait', async () => {
    const wake = new WakeSignal();
    const waiting = wake.wait(10_000);
    wake.notify();
    await waiting;
    await wake.wait(10_000); // still notified
    wake.clear();
    const started = performance.now();
    await wake.wait(5);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4);
  });

  it('withTimeout rejects with a TimeoutError', async () => {
    await expect(withTimeout(new Promise(() => {}), 5)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
