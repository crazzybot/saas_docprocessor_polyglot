/**
 * Per-request context: an OpenTelemetry server span (continuing the caller's
 * trace from `traceparent`), a correlation ID, and a completion log line.
 *
 * Both the span and the correlation ID are bound to the request's async
 * context, so every log line and child span produced while handling it picks
 * them up without being passed around.
 */

import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { getLogger, getTracer, runWithCorrelationId } from '@docprocessor/shared';
import type { NextFunction, Request, Response } from 'express';

const logger = getLogger('document_service.api.middleware');
const tracer = getTracer('document_service.api');

/**
 * Liveness/readiness probes (Docker HEALTHCHECK, kubelet) hit these every few
 * seconds; they are not traced and are logged at DEBUG only.
 */
export const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(request: Request, response: Response, next: NextFunction): void {
    const correlationId = request.header('x-correlation-id') || randomUUID();
    response.setHeader('X-Correlation-ID', correlationId);
    // originalUrl: a mounted middleware sees `request.path` relative to its mount point.
    const path = request.originalUrl.split('?', 1)[0] ?? '/';
    const isProbe = PROBE_PATHS.has(path);
    const start = performance.now();

    let requestContext = context.active();
    const span = isProbe
      ? undefined
      : tracer.startSpan(
          request.method,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'http.request.method': request.method,
              'url.path': path,
              'url.scheme': request.protocol,
            },
          },
          propagation.extract(ROOT_CONTEXT, request.headers),
        );
    if (span) {
      requestContext = trace.setSpan(requestContext, span);
    }

    response.on('finish', () => {
      // Route templates (e.g. /documents/:docId) keep span names low-cardinality.
      const route = (request.route as { path?: string } | undefined)?.path;
      if (span) {
        span.updateName(route ? `${request.method} ${route}` : request.method);
        if (route) {
          span.setAttribute('http.route', route);
        }
        span.setAttribute('http.response.status_code', response.statusCode);
        if (response.statusCode >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
      }
      context.with(requestContext, () =>
        runWithCorrelationId(correlationId, () =>
          logger.log(isProbe ? 'DEBUG' : 'INFO', 'request_completed', {
            path,
            method: request.method,
            status_code: response.statusCode,
            duration_ms: Math.round((performance.now() - start) * 100) / 100,
          }),
        ),
      );
      span?.end();
    });

    context.with(requestContext, () => runWithCorrelationId(correlationId, next));
  }
}
