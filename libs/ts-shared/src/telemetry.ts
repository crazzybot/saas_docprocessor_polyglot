/**
 * OpenTelemetry setup and trace-context helpers shared by every service.
 *
 * Usage:
 *   configureTelemetry('document-service');
 *   const tracer = getTracer('documents');
 *   await withSpan(tracer, 'upload_document', async (span) => { ... });
 *
 * Spans are exported over OTLP gRPC when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (the in-cluster collector, or the Aspire Dashboard locally). Without an
 * endpoint, tracing still runs, so log lines carry trace and span IDs, but
 * spans are only printed when OTEL_TRACES_EXPORTER=console. With
 * OTEL_LOGS_EXPORTER=otlp, log records are exported to the same endpoint.
 */

import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs';
import { BatchSpanProcessor, ConsoleSpanExporter, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { addLogSink, describeError, errorMessage, type LogLevelName, type LogRecord } from './logging.js';

let tracerProvider: NodeTracerProvider | undefined;
let loggerProvider: LoggerProvider | undefined;

export interface TelemetryOptions {
  /** Defaults to OTEL_EXPORTER_OTLP_ENDPOINT. */
  otlpEndpoint?: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/**
 * Configure the process-wide tracer provider (and, optionally, OTLP log
 * export). Idempotent. Registering the provider also installs the
 * AsyncLocalStorage context manager and the W3C trace-context propagator.
 */
export function configureTelemetry(serviceName: string, options: TelemetryOptions = {}): void {
  if (tracerProvider) {
    return;
  }
  const env = options.env ?? process.env;
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName });
  const endpoint = options.otlpEndpoint ?? (env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined);

  const spanProcessors: SpanProcessor[] = [];
  if (endpoint) {
    spanProcessors.push(new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint })));
    // Opt-in: in AKS, Container Insights already collects stdout, so
    // exporting logs too would duplicate them. The local stack enables it so
    // logs show up in the Aspire Dashboard next to the traces.
    if ((env.OTEL_LOGS_EXPORTER ?? 'none').toLowerCase() === 'otlp') {
      configureLogExport(resource, endpoint);
    }
  }
  if ((env.OTEL_TRACES_EXPORTER ?? '').toLowerCase() === 'console') {
    spanProcessors.push(new BatchSpanProcessor(new ConsoleSpanExporter()));
  }

  tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  tracerProvider.register();
}

/** Flush and stop exporters; call before the process exits. */
export async function shutdownTelemetry(): Promise<void> {
  await Promise.allSettled([tracerProvider?.shutdown(), loggerProvider?.shutdown()]);
}

const SEVERITY: Record<LogLevelName, SeverityNumber> = {
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARNING: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  CRITICAL: SeverityNumber.FATAL,
};

function toAttributeValue(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value); // objects; undefined for functions/symbols
}

/**
 * Ship log records over OTLP, alongside the stdout JSON lines. Structured
 * fields become top-level attributes; the active span (if any) links each
 * record to its trace.
 */
function configureLogExport(resource: Resource, endpoint: string): void {
  loggerProvider = new LoggerProvider({
    resource,
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: endpoint }) })],
  });
  const provider = loggerProvider;
  addLogSink((record: LogRecord) => {
    provider.getLogger(record.logger).emit({
      timestamp: record.timestamp,
      severityNumber: SEVERITY[record.level],
      severityText: record.level,
      body: record.message,
      attributes: logRecordAttributes(record),
    });
  });
}

/**
 * A log record's OTLP attributes: the correlation ID, each structured field
 * (non-primitive values as JSON, nulls dropped), and the exception stack.
 */
export function logRecordAttributes(record: LogRecord): Attributes {
  const attributes: Attributes = { correlation_id: record.correlationId };
  for (const [key, value] of Object.entries(record.fields)) {
    const attribute = toAttributeValue(value);
    if (attribute !== undefined) {
      attributes[key] = attribute;
    }
  }
  if (record.error !== undefined) {
    attributes['exception.stacktrace'] = describeError(record.error);
  }
  return attributes;
}

export function getTracer(name: string): Tracer {
  return trace.getTracer(name);
}

/**
 * Serialise the current trace context (W3C `traceparent` / `tracestate`) into
 * a string map suitable for message application properties, so a consumer
 * can continue the same distributed trace.
 */
export function injectTraceContext(ctx: Context = context.active()): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier;
}

/**
 * Rebuild a parent trace context from message application properties (or
 * HTTP headers). Values are normalised to strings first: Service Bus may
 * deliver them as Buffers.
 */
export function extractTraceContext(carrier: Record<string, unknown> | undefined | null): Context {
  const normalised: Record<string, string> = {};
  for (const [key, value] of Object.entries(carrier ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Buffer.isBuffer(value)) {
      normalised[key] = value.toString('utf8');
    } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      normalised[key] = String(value);
    }
  }
  return propagation.extract(ROOT_CONTEXT, normalised);
}

export interface SpanOptions {
  parent?: Context;
  attributes?: Attributes;
}

/**
 * Run `fn` inside a new active span. An exception is recorded on the span,
 * which is marked as failed, and rethrown.
 */
export async function withSpan<T>(
  tracer: Tracer,
  name: string,
  fn: (span: Span) => Promise<T>,
  options: SpanOptions = {},
): Promise<T> {
  const parent = options.parent ?? context.active();
  return tracer.startActiveSpan(name, { attributes: options.attributes ?? {} }, parent, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : errorMessage(error));
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage(error) });
      throw error;
    } finally {
      span.end();
    }
  });
}
