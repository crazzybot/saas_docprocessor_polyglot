/**
 * Builds the concrete adapters and wires them into `DocumentService`, and
 * owns the background tasks (outbox relay, results consumer, maintenance).
 *
 * Together with `main.ts` and `app.module.ts` this is the composition root:
 * the only code that knows which adapter implements which port.
 */

import type { BeforeApplicationShutdown, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { AzureClientFactory, ensureContainer, getLogger, shutdownTelemetry } from '@docprocessor/shared';
import type { ServiceBusClient, ServiceBusSender } from '@azure/service-bus';
import type pg from 'pg';

import { BlobDocumentStorage } from './adapters/blob-storage.js';
import { createPool, runMigrations } from './adapters/postgres/database.js';
import { PostgresDocumentRepository } from './adapters/postgres/repository.js';
import { OutboxRelay } from './adapters/service-bus/outbox-relay.js';
import { ExtractionResultsConsumer } from './adapters/service-bus/results-consumer.js';
import type { AppDependencies } from './app.module.js';
import { DocumentService } from './application/document.service.js';
import { runMaintenanceLoop } from './application/maintenance.js';
import type { Settings } from './config.js';

const logger = getLogger('document_service.main');

const HOUR_MS = 3_600_000;

export class Infrastructure implements OnApplicationBootstrap, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly abort = new AbortController();
  private tasks: Promise<void>[] = [];

  private constructor(
    private readonly settings: Settings,
    private readonly clients: { serviceBus: ServiceBusClient; sender: ServiceBusSender; pool: pg.Pool },
    private readonly parts: {
      repository: PostgresDocumentRepository;
      storage: BlobDocumentStorage;
      service: DocumentService;
      relay: OutboxRelay;
      consumer: ExtractionResultsConsumer;
    },
  ) {}

  /** What `AppModule.forRoot` needs; this object's hooks run the background work. */
  get dependencies(): AppDependencies {
    const { repository, storage, service } = this.parts;
    return { settings: this.settings, repository, storage, service, lifecycle: this };
  }

  /** Create clients and the pool, run migrations, and wire the service. */
  static async create(settings: Settings): Promise<Infrastructure> {
    logger.info('startup: initialising clients');
    if (settings.authEnabled && settings.allowedTenantIds.size === 0) {
      logger.warn('startup: AZURE_AD_ALLOWED_TENANT_IDS is empty; every token will be rejected');
    }
    const factory = new AzureClientFactory();
    const blobServiceClient = factory.blobServiceClient({
      accountUrl: settings.storageAccountUrl,
      connectionString: settings.azureStorageConnectionString,
    });
    const serviceBusClient = factory.serviceBusClient({
      fullyQualifiedNamespace: settings.serviceBusNamespace,
      connectionString: settings.serviceBusConnectionString,
    });
    const sender = serviceBusClient.createSender(settings.serviceBusEventsTopicName);
    const pool = createPool(settings, settings.postgresEntraAuth ? { credential: factory.credential() } : {});

    try {
      if (settings.dbRunMigrations) {
        await runMigrations(pool);
      }
      // A failure here is logged, and /readyz keeps the pod out of rotation
      // until storage is reachable.
      try {
        await ensureContainer(blobServiceClient, settings.blobContainerName);
      } catch (error) {
        logger.error('startup: failed to ensure blob container exists', {}, error);
      }
    } catch (error) {
      await Promise.allSettled([sender.close(), serviceBusClient.close(), pool.end()]);
      throw error;
    }

    const repository = new PostgresDocumentRepository(pool);
    const storage = new BlobDocumentStorage(blobServiceClient);
    const relay = new OutboxRelay(repository, sender, {
      batchSize: settings.outboxBatchSize,
      pollIntervalMs: settings.outboxPollIntervalSeconds * 1000,
    });
    const service = new DocumentService(repository, storage, {
      rawContainer: settings.blobContainerName,
      notifyOutbox: () => relay.notify(),
    });
    const consumer = new ExtractionResultsConsumer(
      service,
      () =>
        serviceBusClient.createReceiver(
          settings.serviceBusResultsTopicName,
          settings.serviceBusResultsSubscriptionName,
        ),
      {
        resultsContainer: settings.resultsContainerName,
        maxWaitTimeMs: settings.consumerMaxWaitTimeSeconds * 1000,
        maxDeliveryAttempts: settings.consumerMaxDeliveryAttempts,
      },
    );

    return new Infrastructure(
      settings,
      { serviceBus: serviceBusClient, sender, pool },
      { repository, storage, service, relay, consumer },
    );
  }

  /** Start the background tasks once the app is initialised. */
  onApplicationBootstrap(): void {
    const { signal } = this.abort;
    this.tasks = [
      this.parts.relay.run(signal),
      this.parts.consumer.run(signal),
      runMaintenanceLoop(this.parts.service, {
        intervalMs: this.settings.maintenanceIntervalSeconds * 1000,
        tombstoneRetentionMs: this.settings.tombstoneRetentionHours * HOUR_MS,
        outboxRetentionMs: this.settings.outboxRetentionHours * HOUR_MS,
        signal,
      }),
    ];
  }

  async beforeApplicationShutdown(): Promise<void> {
    logger.info('shutdown: stopping background tasks');
    this.abort.abort();
    await Promise.allSettled(this.tasks);
  }

  /** Runs after the HTTP server has stopped accepting requests. */
  async onApplicationShutdown(): Promise<void> {
    logger.info('shutdown: closing clients');
    // The Blob Storage client is plain HTTP and holds nothing to close.
    await Promise.allSettled([this.clients.sender.close(), this.clients.serviceBus.close()]);
    await this.clients.pool.end().catch((error: unknown) => logger.warn('shutdown: pool close failed', {}, error));
    // Last, so spans and logs from the shutdown itself are exported too.
    await shutdownTelemetry();
  }
}
