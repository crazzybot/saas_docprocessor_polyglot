"""Processing of a single extraction job: download -> extract -> upload -> notify."""

from __future__ import annotations

import json
import logging
import time
from datetime import UTC, datetime
from typing import Any

from azure.core.exceptions import ResourceNotFoundError
from azure.servicebus import ServiceBusMessage
from azure.servicebus.aio import ServiceBusClient
from azure.storage.blob.aio import BlobServiceClient
from opentelemetry.context import Context
from pydantic import ValidationError

from docprocessor_shared.contracts import (
    DocumentUploadedEvent,
    ExtractionCompletedEvent,
    ExtractionStatus,
    result_blob_name,
)
from docprocessor_shared.telemetry import get_tracer, log_with_trace
from worker_service.config import settings
from worker_service.extractors import UnsupportedContentTypeError, extract_text
from worker_service.metrics import EXTRACTION_DURATION_SECONDS

logger = logging.getLogger(__name__)
tracer = get_tracer(__name__)


class PermanentProcessingError(Exception):
    """Raised for failures that will never succeed on retry (dead-letter it)."""


def parse_job(body: str) -> DocumentUploadedEvent:
    """Parse and validate a job message body (the shared `document.uploaded`
    contract). A malformed message can never succeed, so it is a permanent
    failure."""
    try:
        return DocumentUploadedEvent.model_validate_json(body)
    except ValidationError as exc:
        raise PermanentProcessingError(f"invalid job message: {exc}") from exc


# --------------------------------------------------------------------------
# Blob storage helpers
# --------------------------------------------------------------------------
async def download_blob(blob_service_client: BlobServiceClient, container: str, blob_name: str) -> bytes:
    blob_client = blob_service_client.get_blob_client(container=container, blob=blob_name)
    downloader = await blob_client.download_blob()
    return await downloader.readall()


async def upload_result_json(
    blob_service_client: BlobServiceClient,
    container: str,
    blob_name: str,
    result: dict[str, Any],
) -> str:
    # The container is ensured once at startup (Worker.serve), not per job.
    blob_client = blob_service_client.get_container_client(container).get_blob_client(blob_name)
    await blob_client.upload_blob(
        json.dumps(result).encode("utf-8"),
        overwrite=True,
        content_type="application/json",
    )
    return blob_client.url


# --------------------------------------------------------------------------
# Completion events and the job pipeline
# --------------------------------------------------------------------------
async def publish_completion_event(
    service_bus_client: ServiceBusClient,
    *,
    doc_id: str,
    tenant_id: str,
    status_value: str,
    result_blob_url: str | None,
    correlation_id: str | None,
    error: str | None = None,
) -> None:
    """Send a completion (success or failure) event to the results topic so
    the downstream AI analysis pipeline can react to newly extracted text.

    The body, `message_id` (deterministic per doc and status, for duplicate
    detection) and application properties come from the shared
    `ExtractionCompletedEvent` contract.
    """
    event = ExtractionCompletedEvent(
        doc_id=doc_id,
        tenant_id=tenant_id,
        status=ExtractionStatus(status_value),
        result_blob_url=result_blob_url,
        error=error,
    )
    message = ServiceBusMessage(
        event.to_json(),
        content_type="application/json",
        message_id=event.message_id,
        correlation_id=correlation_id,
        application_properties=event.application_properties(),
    )
    async with service_bus_client.get_topic_sender(topic_name=settings.service_bus_results_topic_name) as sender:
        await sender.send_messages(message)


async def process_job_message(
    job: DocumentUploadedEvent,
    *,
    blob_service_client: BlobServiceClient,
    service_bus_client: ServiceBusClient,
    parent_context: Context | None = None,
) -> None:
    """Process a single extraction job: download -> extract -> upload -> notify.

    Raises `PermanentProcessingError` for failures that should be dead-lettered
    rather than retried (e.g. unsupported content type, corrupt or missing file).
    """
    doc_id = job.doc_id
    tenant_id = job.tenant_id
    content_type = job.content_type
    blob_container = job.blob_container or settings.blob_container_name
    correlation_id = job.correlation_id

    with tracer.start_as_current_span("process_extraction_job", context=parent_context) as span:
        span.set_attribute("doc_id", doc_id)
        span.set_attribute("tenant_id", tenant_id)
        span.set_attribute("content_type", content_type)

        log_with_trace(
            logger,
            logging.INFO,
            "processing_job_started",
            extra={"doc_id": doc_id, "tenant_id": tenant_id, "content_type": content_type},
        )

        try:
            blob_name = job.resolve_blob_name(blob_container)
        except ValueError as exc:
            raise PermanentProcessingError(str(exc)) from exc

        with tracer.start_as_current_span("download_blob"):
            try:
                data = await download_blob(blob_service_client, blob_container, blob_name)
            except ResourceNotFoundError as exc:
                raise PermanentProcessingError(f"source blob not found: {blob_name}") from exc
            # Other storage failures (network blips, throttling) propagate
            # unchanged so the caller's retry/dead-letter policy applies.

        start_time = time.perf_counter()
        try:
            with tracer.start_as_current_span("extract_text"):
                extracted_text = await extract_text(content_type, data)
        except UnsupportedContentTypeError as exc:
            raise PermanentProcessingError(str(exc)) from exc
        except Exception as exc:
            raise PermanentProcessingError(f"extraction failed: {exc}") from exc
        finally:
            EXTRACTION_DURATION_SECONDS.labels(content_type=content_type).observe(time.perf_counter() - start_time)

        result_payload = {
            "doc_id": doc_id,
            "tenant_id": tenant_id,
            "filename": job.filename,
            "content_type": content_type,
            "extracted_text": extracted_text,
            "char_count": len(extracted_text),
            "extracted_at": datetime.now(UTC).isoformat(),
        }

        with tracer.start_as_current_span("upload_result"):
            result_blob_url = await upload_result_json(
                blob_service_client,
                settings.results_container_name,
                result_blob_name(tenant_id, doc_id),
                result_payload,
            )

        await publish_completion_event(
            service_bus_client,
            doc_id=doc_id,
            tenant_id=tenant_id,
            status_value="succeeded",
            result_blob_url=result_blob_url,
            correlation_id=correlation_id,
        )

        log_with_trace(
            logger,
            logging.INFO,
            "processing_job_succeeded",
            extra={"doc_id": doc_id, "result_blob_url": result_blob_url},
        )
