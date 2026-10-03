/**
 * Maps errors to HTTP responses, in one place, so the lower layers stay free
 * of HTTP concerns. Every error body is `{"detail": ...}`.
 */

import { Catch, HttpException, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { getLogger } from '@docprocessor/shared';
import type { Request, Response } from 'express';

import { SETTINGS, type Settings } from '../config.js';
import {
  ContentMissingError,
  DocumentNotFoundError,
  InvalidCursorError,
  RepositoryUnavailableError,
  StorageUnavailableError,
  TextNotAvailableError,
  VersionConflictError,
} from '../domain/errors.js';
import { ApiError } from './api-error.js';

const logger = getLogger('document_service.api.errors');

interface ErrorResponse {
  status: number;
  detail: unknown;
  headers?: Record<string, string>;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(@Inject(SETTINGS) private readonly settings: Pick<Settings, 'maxUploadSizeMb'>) {}

  private toResponse(error: unknown, request: Request): ErrorResponse {
    if (error instanceof ApiError) {
      return { status: error.status, detail: error.detail, headers: { ...error.headers } };
    }
    if (error instanceof DocumentNotFoundError) {
      return { status: 404, detail: 'Document not found' };
    }
    if (error instanceof VersionConflictError) {
      return { status: 412, detail: 'Document has been modified', headers: { ETag: `"${error.currentVersion}"` } };
    }
    if (error instanceof TextNotAvailableError) {
      return { status: 409, detail: error.message };
    }
    if (error instanceof ContentMissingError) {
      logger.error('content_missing', { blob: error.message });
      return { status: 404, detail: 'Document content not found' };
    }
    if (error instanceof InvalidCursorError) {
      return { status: 400, detail: 'Invalid cursor' };
    }
    if (error instanceof RepositoryUnavailableError || error instanceof StorageUnavailableError) {
      logger.error('dependency_unavailable', { error: error.message });
      return {
        status: 503,
        detail: 'Service temporarily unavailable; please retry',
        headers: { 'Retry-After': '5' },
      };
    }
    if (error instanceof HttpException) {
      // Nest's own errors: unknown routes, and multer's upload limits.
      const status = error.getStatus();
      if (status === 413) {
        return { status, detail: `File exceeds maximum size of ${this.settings.maxUploadSizeMb}MB` };
      }
      return { status, detail: error.message };
    }
    logger.error('unhandled_exception', { path: request.path }, error);
    return { status: 500, detail: 'internal server error' };
  }

  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const { status, detail, headers } = this.toResponse(error, http.getRequest<Request>());
    if (response.headersSent) {
      // A streamed body failed midway; all we can do is cut the connection.
      response.destroy();
      return;
    }
    response
      .status(status)
      .set(headers ?? {})
      .json({ detail });
  }
}
