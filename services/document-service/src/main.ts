/**
 * Document microservice for the SaaS document processing platform.
 *
 * This is the entry point of the composition root: it configures logging
 * and telemetry, builds the infrastructure, and starts the Nest app. Layout:
 *
 *   domain/          documents, lifecycle events, errors (no I/O)
 *   application/     DocumentService use cases, the ports they depend on, maintenance
 *   adapters/        PostgreSQL catalog + outbox, Blob Storage, Service Bus relay/consumer
 *   api/             controllers, schemas, auth, validation, error mapping, middleware, probes
 *   infrastructure   builds adapters, wires the service, runs background tasks
 *   app.module       the Nest module over those dependencies
 *
 * Responsibilities:
 *   - Accept multipart document uploads (PDF, DOCX, PNG/JPG), store them in
 *     Blob Storage, and record them in the PostgreSQL catalog together with a
 *     `document.uploaded` event (transactional outbox).
 *   - Serve the catalog: list (cursor-paged), get, update metadata (ETag /
 *     If-Match), delete (tombstone + blob cleanup), and stream the raw file
 *     and the extracted text.
 *   - Relay outbox events to the `document-events` topic; a filtered
 *     subscription forwards uploads to the worker's `extraction-jobs` queue.
 *   - Consume the worker's `extraction-results` events to update status.
 *   - Authenticate callers with Microsoft Entra ID; the tenant comes from the token.
 *   - Expose liveness/readiness probes, JSON logs with correlation IDs, and
 *     OpenTelemetry traces propagated to the worker through the event.
 *
 * Run locally (from the repository root) with:
 *   just dev document-service
 */

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  configureLogging,
  configureTelemetry,
  exitOnSignals,
  getLogger,
  loadDotEnv,
  NestJsonLogger,
  shutdownTelemetry,
} from '@docprocessor/shared';

import { AppModule } from './app.module.js';
import { loadDocumentServiceSettings } from './config.js';
import { Infrastructure } from './infrastructure.js';

loadDotEnv();
const settings = loadDocumentServiceSettings();
configureLogging(settings.logLevel, { azureSdkLevel: settings.azureSdkLogLevel });
configureTelemetry(settings.otelServiceName);
const logger = getLogger('document_service.main');

async function bootstrap(): Promise<void> {
  const infrastructure = await Infrastructure.create(settings);
  const app = await NestFactory.create(AppModule.forRoot(infrastructure.dependencies), {
    logger: new NestJsonLogger(),
  });
  // SIGTERM/SIGINT -> app.close(): stop background tasks, stop the HTTP
  // server, then close clients (see Infrastructure's lifecycle hooks).
  exitOnSignals(() => app.close());
  await app.listen(settings.port, '0.0.0.0');
  logger.info('document_service_started', { port: settings.port });
}

/**
 * Log any crash through the JSON logger (so it reaches the OTLP log export,
 * flushed before exit), then exit non-zero.
 */
async function crash(error: unknown): Promise<never> {
  logger.critical('document_service_crashed', {}, error);
  await shutdownTelemetry();
  process.exit(1);
}

process.on('unhandledRejection', (error) => void crash(error));

try {
  await bootstrap();
} catch (error) {
  await crash(error);
}
