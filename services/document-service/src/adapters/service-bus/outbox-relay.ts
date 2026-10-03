/**
 * Outbox relay: publishes committed lifecycle events to Service Bus.
 *
 * Events are written to the `outbox` table in the same transaction as the
 * change they describe; this relay sends them afterwards. Delivery is
 * at-least-once: a crash between send and the `published_at` update resends
 * the batch, and duplicate detection on the topic (keyed on `messageId`) drops
 * the repeats. Every replica runs a relay; `FOR UPDATE SKIP LOCKED` gives each
 * one a disjoint batch.
 */

import { getLogger, sleep, WakeSignal } from '@docprocessor/shared';
import type { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';

import type { DocumentRepository } from '../../application/ports.js';
import { RepositoryUnavailableError } from '../../domain/errors.js';
import type { OutboxRecord } from '../../domain/models.js';

const logger = getLogger('document_service.adapters.service_bus.outbox_relay');

const MAX_BACKOFF_MS = 30_000;

/** The subset of `ServiceBusSender` the relay uses. */
export type EventSender = Pick<ServiceBusSender, 'createMessageBatch' | 'sendMessages'>;

export function toServiceBusMessage(record: OutboxRecord): ServiceBusMessage {
  const { event } = record;
  const correlationId = event.body.correlation_id;
  return {
    // An object body is sent as UTF-8 JSON in the AMQP data section, which
    // every Service Bus SDK reads back as the same JSON text.
    body: event.body,
    contentType: 'application/json',
    messageId: event.messageId,
    ...(typeof correlationId === 'string' && correlationId ? { correlationId } : {}),
    applicationProperties: { ...event.properties },
  };
}

export class OutboxRelay {
  private readonly wake = new WakeSignal();

  constructor(
    private readonly repo: DocumentRepository,
    private readonly sender: EventSender,
    private readonly options: { batchSize: number; pollIntervalMs: number },
  ) {}

  /** Called after a commit that wrote an outbox row. */
  notify(): void {
    this.wake.notify();
  }

  private readonly send = async (records: readonly OutboxRecord[]): Promise<void> => {
    let batch = await this.sender.createMessageBatch();
    for (const record of records) {
      const message = toServiceBusMessage(record);
      if (batch.tryAddMessage(message)) {
        continue;
      }
      await this.sender.sendMessages(batch);
      batch = await this.sender.createMessageBatch();
      if (!batch.tryAddMessage(message)) {
        throw new Error(`outbox event ${record.event.messageId} exceeds the maximum message size`);
      }
    }
    await this.sender.sendMessages(batch);
  };

  /** Publish until the outbox is drained. Returns the number sent. */
  async publishPending(): Promise<number> {
    let total = 0;
    for (;;) {
      const sent = await this.repo.publishOutbox(this.options.batchSize, this.send);
      total += sent;
      if (sent < this.options.batchSize) {
        break;
      }
    }
    if (total) {
      logger.debug('outbox_published', { count: total });
    }
    return total;
  }

  /** Relay loop; stops when `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.options.pollIntervalMs;
    while (!signal.aborted) {
      this.wake.clear();
      try {
        await this.publishPending();
        backoff = this.options.pollIntervalMs;
      } catch (error) {
        if (error instanceof RepositoryUnavailableError || isServiceBusError(error)) {
          logger.warn('outbox_publish_failed', {}, error);
        } else {
          // A bug must not silently stop the relay.
          logger.error('outbox_relay_unexpected_error', {}, error);
        }
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        await sleep(backoff, signal);
        continue;
      }
      await this.wake.wait(this.options.pollIntervalMs, signal);
    }
  }
}

/** Service Bus and AMQP errors carry a `code` (e.g. `ServiceBusError`, `MessagingError`). */
export function isServiceBusError(error: unknown): boolean {
  return error instanceof Error && ['ServiceBusError', 'MessagingError'].includes(error.name);
}
