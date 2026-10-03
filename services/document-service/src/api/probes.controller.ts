/** Liveness and readiness probes (not routed through the ingress). */

import { Controller, Get, Inject } from '@nestjs/common';
import { errorMessage, getLogger, withTimeout } from '@docprocessor/shared';

import {
  DOCUMENT_REPOSITORY,
  DOCUMENT_STORAGE,
  type DocumentRepository,
  type DocumentStorage,
} from '../application/ports.js';
import { SETTINGS, type Settings } from '../config.js';
import { ApiError } from './api-error.js';
import { Public } from './auth.js';

const logger = getLogger('document_service.api.probes');

const CHECK_TIMEOUT_MS = 3_000;

@Controller()
@Public()
export class ProbesController {
  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly repository: DocumentRepository,
    @Inject(DOCUMENT_STORAGE) private readonly storage: DocumentStorage,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  /** Liveness: the process is up and able to serve requests. */
  @Get('healthz')
  health(): { status: string } {
    return { status: 'ok' };
  }

  /**
   * Readiness: the catalog database and Blob Storage are reachable.
   *
   * Service Bus is deliberately not checked: uploads only write to the
   * database (the outbox relay publishes later), so a broker outage delays
   * events but does not affect any request.
   */
  @Get('readyz')
  async ready(): Promise<{ status: string }> {
    await this.check('database', 'database unavailable', () => this.repository.ping());
    await this.check('storage', 'storage backend unavailable', () =>
      this.storage.ping(this.settings.blobContainerName),
    );
    return { status: 'ready' };
  }

  private async check(dependency: string, detail: string, ping: () => Promise<void>): Promise<void> {
    try {
      await withTimeout(ping(), CHECK_TIMEOUT_MS);
    } catch (error) {
      logger.warn('readiness_check_failed', {
        dependency,
        error: errorMessage(error),
      });
      throw new ApiError(503, detail);
    }
  }
}
