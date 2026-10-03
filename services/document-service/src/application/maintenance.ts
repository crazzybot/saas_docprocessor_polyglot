/**
 * Periodic maintenance: retry blob cleanup for tombstones and purge old
 * tombstones and published outbox rows (see `DocumentService.runMaintenance`).
 */

import { getLogger, sleep } from '@docprocessor/shared';

import { RepositoryUnavailableError, StorageUnavailableError } from '../domain/errors.js';
import type { DocumentService } from './document.service.js';

const logger = getLogger('document_service.application.maintenance');

/** Runs until `signal` aborts. Failures are logged; the next run retries. */
export async function runMaintenanceLoop(
  service: DocumentService,
  options: { intervalMs: number; tombstoneRetentionMs: number; outboxRetentionMs: number; signal: AbortSignal },
): Promise<void> {
  while (!options.signal.aborted) {
    await sleep(options.intervalMs, options.signal);
    if (options.signal.aborted) {
      break;
    }
    try {
      await service.runMaintenance({
        tombstoneRetentionMs: options.tombstoneRetentionMs,
        outboxRetentionMs: options.outboxRetentionMs,
      });
    } catch (error) {
      if (error instanceof RepositoryUnavailableError || error instanceof StorageUnavailableError) {
        logger.warn('maintenance_failed', {}, error);
      } else {
        // Keep the loop alive; the next run retries.
        logger.error('maintenance_unexpected_error', {}, error);
      }
    }
  }
}
