/**
 * Consumer for the worker's completion events (`extraction-results` topic).
 *
 * Reads from this service's own subscription and moves documents from
 * `queued` to `succeeded`/`failed`. Processing is idempotent (status only
 * moves forward), so redelivered or duplicate events are harmless.
 */

import {
  ContractError,
  errorMessage,
  ExtractionCompletedEvents,
  getLogger,
  runWithCorrelationId,
  sleep,
} from '@docprocessor/shared';
import type { ServiceBusReceivedMessage, ServiceBusReceiver } from '@azure/service-bus';

import type { DocumentService } from '../../application/document.service.js';
import { RepositoryUnavailableError, StorageUnavailableError } from '../../domain/errors.js';
import type { ExtractionResult } from '../../domain/models.js';

const logger = getLogger('document_service.adapters.service_bus.results_consumer');

const RECONNECT_DELAY_MS = 5_000;

/** The subset of `ServiceBusReceiver` the consumer uses. */
export type ResultsReceiver = Pick<
  ServiceBusReceiver,
  'receiveMessages' | 'completeMessage' | 'abandonMessage' | 'deadLetterMessage' | 'close'
>;
export type ReceivedMessage = Pick<ServiceBusReceivedMessage, 'body' | 'correlationId' | 'deliveryCount'>;

/** The event can never be processed (malformed); it is dead-lettered. */
export class InvalidEventError extends Error {
  override readonly name = 'InvalidEventError';
}

/**
 * Parse the worker's `ExtractionCompletedEvent` into the domain's
 * `ExtractionResult`. A malformed body throws InvalidEventError.
 */
export function parseResultEvent(body: unknown, options: { resultsContainer: string }): ExtractionResult {
  let event;
  try {
    event = ExtractionCompletedEvents.parse(body);
  } catch (error) {
    if (error instanceof ContractError) {
      throw new InvalidEventError(error.message, { cause: error });
    }
    throw error;
  }
  const name = ExtractionCompletedEvents.resultBlobName(event, options.resultsContainer);
  return {
    tenantId: event.tenant_id,
    docId: event.doc_id,
    status: event.status,
    textBlob: name ? { container: options.resultsContainer, name } : null,
    error: event.error,
    completedAt: new Date(event.completed_at),
  };
}

export class ExtractionResultsConsumer {
  connected = false;

  constructor(
    private readonly service: DocumentService,
    private readonly createReceiver: () => ResultsReceiver,
    private readonly options: { resultsContainer: string; maxWaitTimeMs: number; maxDeliveryAttempts: number },
  ) {}

  async handle(receiver: ResultsReceiver, message: ReceivedMessage): Promise<void> {
    const correlationId = typeof message.correlationId === 'string' ? message.correlationId : '-';
    await runWithCorrelationId(correlationId || '-', async () => {
      let result: ExtractionResult;
      try {
        result = parseResultEvent(message.body, { resultsContainer: this.options.resultsContainer });
      } catch (error) {
        if (!(error instanceof InvalidEventError)) {
          throw error;
        }
        logger.error('result_event_dead_lettered', { reason: error.message });
        await receiver.deadLetterMessage(message as ServiceBusReceivedMessage, {
          deadLetterReason: 'InvalidEvent',
          deadLetterErrorDescription: error.message,
        });
        return;
      }
      try {
        await this.service.applyExtractionResult(result);
      } catch (error) {
        if (error instanceof RepositoryUnavailableError || error instanceof StorageUnavailableError) {
          logger.warn('result_event_failed', { doc_id: result.docId }, error);
        } else {
          // Retry, then dead-letter; never kill the loop.
          logger.error('result_event_unexpected_error', { doc_id: result.docId }, error);
        }
        await this.retryOrDeadLetter(receiver, message, error);
        return;
      }
      await receiver.completeMessage(message as ServiceBusReceivedMessage);
    });
  }

  private async retryOrDeadLetter(receiver: ResultsReceiver, message: ReceivedMessage, error: unknown): Promise<void> {
    const sbMessage = message as ServiceBusReceivedMessage;
    if ((message.deliveryCount ?? 0) >= this.options.maxDeliveryAttempts) {
      await receiver.deadLetterMessage(sbMessage, {
        deadLetterReason: 'MaxDeliveryAttemptsExceeded',
        deadLetterErrorDescription: errorMessage(error),
      });
    } else {
      await receiver.abandonMessage(sbMessage);
    }
  }

  /** Receive loop with reconnect; stops when `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const receiver = this.createReceiver();
      try {
        while (!signal.aborted) {
          const messages = await receiver.receiveMessages(20, {
            maxWaitTimeInMs: this.options.maxWaitTimeMs,
            abortSignal: signal,
          });
          if (!this.connected) {
            this.connected = true;
            logger.info('results_consumer_connected');
          }
          for (const message of messages) {
            await this.handle(receiver, message);
          }
        }
      } catch (error) {
        if (!signal.aborted) {
          logger.warn('results_consumer_disconnected', {}, error);
        }
      } finally {
        this.connected = false;
        await receiver.close().catch(() => undefined);
      }
      await sleep(RECONNECT_DELAY_MS, signal);
    }
  }
}
