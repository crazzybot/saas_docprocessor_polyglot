/**
 * Builders for the lifecycle events published on the `document-events` topic.
 *
 * Every event carries `event_type`, `tenant_id` and `doc_id` as application
 * properties so subscriptions can filter on them. `document.uploaded` is also
 * the worker's job (it arrives through auto-forwarding into
 * `extraction-jobs`), so its body is the shared `DocumentUploadedEvent`
 * contract.
 */

import { DocumentUploadedEvents } from '@docprocessor/shared';

import { EventType, type Document, type OutboxEvent } from './models.js';

function properties(
  eventType: EventType,
  doc: Document,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { event_type: eventType, tenant_id: doc.tenantId, doc_id: doc.id, ...extra };
}

/**
 * `message_id` is the doc ID (see `DocumentUploadedEvents.messageId`).
 *
 * The trace context is captured now, while the upload request's span is
 * current, and stored with the event so the worker's spans still join the
 * upload trace even though the message is sent later by the relay.
 */
export function documentUploaded(
  doc: Document,
  options: { blobUrl: string; correlationId: string; traceContext: Readonly<Record<string, string>> },
): OutboxEvent {
  const event = DocumentUploadedEvents.create({
    doc_id: doc.id,
    tenant_id: doc.tenantId,
    filename: doc.filename,
    content_type: doc.contentType,
    size_bytes: doc.sizeBytes,
    blob_name: doc.rawBlob.name,
    blob_url: options.blobUrl,
    blob_container: doc.rawBlob.container,
    correlation_id: options.correlationId,
    submitted_at: doc.createdAt.toISOString(),
  });
  return {
    eventType: EventType.UPLOADED,
    messageId: DocumentUploadedEvents.messageId(event),
    body: event,
    properties: properties(EventType.UPLOADED, doc, options.traceContext),
  };
}

export function documentUpdated(doc: Document, options: { correlationId: string }): OutboxEvent {
  return {
    eventType: EventType.UPDATED,
    messageId: `${doc.id}:updated:${doc.version}`,
    body: {
      event_type: EventType.UPDATED,
      doc_id: doc.id,
      tenant_id: doc.tenantId,
      version: doc.version,
      title: doc.title,
      tags: [...doc.tags],
      metadata: { ...doc.metadata },
      correlation_id: options.correlationId,
      updated_at: doc.updatedAt.toISOString(),
    },
    properties: properties(EventType.UPDATED, doc),
  };
}

export function documentDeleted(doc: Document, options: { correlationId: string }): OutboxEvent {
  return {
    eventType: EventType.DELETED,
    messageId: `${doc.id}:deleted`,
    body: {
      event_type: EventType.DELETED,
      doc_id: doc.id,
      tenant_id: doc.tenantId,
      correlation_id: options.correlationId,
      deleted_at: (doc.deletedAt ?? new Date()).toISOString(),
    },
    properties: properties(EventType.DELETED, doc),
  };
}
