/**
 * Structured JSON logging shared by every microservice.
 *
 * Each log line is a single JSON object carrying the current correlation ID
 * (set per request / per message with `runWithCorrelationId`), the active
 * trace and span IDs, and any structured fields passed with the message.
 * Sinks (see `telemetry.ts`) can also receive every record, e.g. to export
 * logs over OTLP.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { setLogLevel, AzureLogger, type AzureLogLevel } from '@azure/logger';
import { trace } from '@opentelemetry/api';

export type LogFields = Record<string, unknown>;

/** Python-style level names, so log queries work the same for every service. */
export const LogLevel = {
  DEBUG: 10,
  INFO: 20,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
} as const;
export type LogLevelName = keyof typeof LogLevel;

export interface LogRecord {
  readonly timestamp: Date;
  readonly level: LogLevelName;
  readonly logger: string;
  readonly message: string;
  readonly correlationId: string;
  readonly fields: LogFields;
  readonly error?: unknown;
}

export type LogSink = (record: LogRecord) => void;

// AsyncLocalStorage lets every log line emitted while handling a request or
// message carry that unit of work's correlation ID without threading it
// through every function signature.
const correlationStorage = new AsyncLocalStorage<string>();

export function currentCorrelationId(): string {
  return correlationStorage.getStore() ?? '-';
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return correlationStorage.run(correlationId, fn);
}

let minLevel: number = LogLevel.INFO;
const sinks: LogSink[] = [];
let writeLine = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

function parseLevel(level: string): LogLevelName {
  const name = level.toUpperCase() === 'WARN' ? 'WARNING' : level.toUpperCase();
  if (!(name in LogLevel)) {
    throw new Error(`unknown log level '${level}'`);
  }
  return name as LogLevelName;
}

const AZURE_LEVELS: Record<LogLevelName, AzureLogLevel> = {
  DEBUG: 'verbose',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'error',
};

/**
 * Configure logging once, at process start.
 *
 * The Azure SDK logs every HTTP request and AMQP link state change at info,
 * which drowns out application logs, so it gets its own (by default quieter)
 * level, and its output is routed through the JSON logger.
 */
export function configureLogging(level: string, options: { azureSdkLevel?: string } = {}): void {
  minLevel = LogLevel[parseLevel(level)];
  const azureLevel = parseLevel(options.azureSdkLevel ?? 'WARNING');
  setLogLevel(AZURE_LEVELS[azureLevel]);
  const azureLogger = new Logger('azure');
  AzureLogger.log = (...args: unknown[]) => {
    azureLogger.log(azureLevel, args.map(String).join(' '));
  };
}

export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

/** Test hook: capture output lines instead of writing to stdout. */
export function setLogWriter(writer: (line: string) => void): () => void {
  const previous = writeLine;
  writeLine = writer;
  return () => {
    writeLine = previous;
  };
}

/**
 * A one-line description of anything thrown. Libraries such as pdf.js throw
 * non-Error objects, and errors crossing a worker thread arrive as plain
 * objects, so `message` is read from any object that has one.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string') {
    return message;
  }
  return JSON.stringify(error) ?? typeof error;
}

/** An error's stack trace, or a readable rendering of a non-Error value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return typeof error === 'string' ? error : (JSON.stringify(error) ?? typeof error);
}

export class Logger {
  constructor(readonly name: string) {}

  isEnabledFor(level: LogLevelName): boolean {
    return LogLevel[level] >= minLevel;
  }

  log(level: LogLevelName, message: string, fields: LogFields = {}, error?: unknown): void {
    if (!this.isEnabledFor(level)) {
      return;
    }
    const record: LogRecord = {
      timestamp: new Date(),
      level,
      logger: this.name,
      message,
      correlationId: currentCorrelationId(),
      fields,
      error,
    };
    const payload: Record<string, unknown> = {
      timestamp: record.timestamp.toISOString(),
      level,
      logger: this.name,
      message,
      correlation_id: record.correlationId,
    };
    const spanContext = trace.getActiveSpan()?.spanContext();
    if (spanContext) {
      payload.trace_id = spanContext.traceId;
      payload.span_id = spanContext.spanId;
    }
    Object.assign(payload, fields);
    if (error !== undefined) {
      payload.exception = describeError(error);
    }
    writeLine(
      JSON.stringify(payload, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
    );
    for (const sink of sinks) {
      sink(record);
    }
  }

  debug(message: string, fields?: LogFields): void {
    this.log('DEBUG', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log('INFO', message, fields);
  }

  warn(message: string, fields?: LogFields, error?: unknown): void {
    this.log('WARNING', message, fields, error);
  }

  error(message: string, fields?: LogFields, error?: unknown): void {
    this.log('ERROR', message, fields, error);
  }

  critical(message: string, fields?: LogFields, error?: unknown): void {
    this.log('CRITICAL', message, fields, error);
  }
}

export function getLogger(name: string): Logger {
  return new Logger(name);
}

/**
 * Adapter that routes NestJS's own logs (bootstrap, route mapping, unhandled
 * errors) through the JSON logger. Structurally implements Nest's
 * `LoggerService`, so this package does not depend on Nest.
 */
export class NestJsonLogger {
  private readonly logger = new Logger('nest');

  private write(level: LogLevelName, message: unknown, params: unknown[]): void {
    // Nest passes the context (class name) as the last optional parameter,
    // and for errors a stack trace before it.
    const context = params.length > 0 && typeof params.at(-1) === 'string' ? (params.at(-1) as string) : undefined;
    const stack = level === 'ERROR' && params.length > 1 ? params[0] : undefined;
    const fields: LogFields = context ? { context } : {};
    if (typeof stack === 'string') {
      fields.exception = stack;
    }
    const text =
      message instanceof Error ? message.message : typeof message === 'string' ? message : JSON.stringify(message);
    this.logger.log(level, text, fields, message instanceof Error ? message : undefined);
  }

  log(message: unknown, ...params: unknown[]): void {
    this.write('INFO', message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write('ERROR', message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write('WARNING', message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write('DEBUG', message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write('DEBUG', message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write('CRITICAL', message, params);
  }
}
