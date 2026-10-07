"""Service Bus consumer loop with bounded concurrency, reconnect backoff and
graceful shutdown."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time

from azure.core.exceptions import AzureError
from azure.servicebus import ServiceBusReceivedMessage
from azure.servicebus.aio import AutoLockRenewer, ServiceBusClient, ServiceBusReceiver
from azure.servicebus.exceptions import ServiceBusError
from azure.storage.blob.aio import BlobServiceClient

from docprocessor_shared.azure_clients import AzureClientFactory, ensure_container
from docprocessor_shared.contracts import DocumentUploadedEvent
from docprocessor_shared.structured_logging import correlation_id_ctx
from docprocessor_shared.telemetry import extract_trace_context
from worker_service.config import settings
from worker_service.metrics import MESSAGES_PROCESSED_TOTAL
from worker_service.processing import (
    PermanentProcessingError,
    parse_job,
    process_job_message,
    publish_completion_event,
)

logger = logging.getLogger(__name__)


class Worker:
    """Owns the Service Bus receiver loop and coordinates graceful shutdown.

    At most `max_concurrency` messages are in flight; the loop only requests
    as many messages as there are free slots, and every received message is
    registered with an `AutoLockRenewer` so long extractions keep their lock.

    On SIGTERM (sent by Kubernetes during pod termination) `shutdown_event`
    is set; the loop stops requesting new batches but awaits any in-flight
    tasks before the process exits, avoiding abandoned/duplicate processing.

    Each loop iteration records a heartbeat; `/healthz` reports unhealthy if
    the heartbeat goes stale, which catches a stuck consumer loop.
    """

    def __init__(self) -> None:
        self.shutdown_event = asyncio.Event()
        self.receiver_ready = False
        self._in_flight_tasks: set[asyncio.Task[None]] = set()
        self._last_heartbeat = time.monotonic()

    def request_shutdown(self) -> None:
        logger.info("shutdown_signal_received")
        self.shutdown_event.set()

    def heartbeat(self) -> None:
        self._last_heartbeat = time.monotonic()

    def is_live(self) -> bool:
        return time.monotonic() - self._last_heartbeat < settings.health_stale_after_seconds

    def is_ready(self) -> bool:
        return self.receiver_ready and not self.shutdown_event.is_set() and self.is_live()

    def free_slots(self) -> int:
        return max(settings.max_concurrency - len(self._in_flight_tasks), 0)

    async def _publish_failure_event(
        self, service_bus_client: ServiceBusClient, job: DocumentUploadedEvent | None, error: str
    ) -> None:
        """Best effort: a failure to announce the failure must not prevent the
        message from being dead-lettered, so it is logged and not raised."""
        if job is None:
            return  # malformed message: no doc_id/tenant_id to report against
        try:
            await publish_completion_event(
                service_bus_client,
                doc_id=job.doc_id,
                tenant_id=job.tenant_id,
                status_value="failed",
                result_blob_url=None,
                correlation_id=job.correlation_id,
                error=error,
            )
        except (ServiceBusError, AzureError):
            logger.exception("failure_event_publish_failed", extra={"fields": {"doc_id": job.doc_id}})

    async def _handle_message(
        self,
        receiver: ServiceBusReceiver,
        message: ServiceBusReceivedMessage,
        *,
        blob_service_client: BlobServiceClient,
        service_bus_client: ServiceBusClient,
    ) -> None:
        job: DocumentUploadedEvent | None = None
        content_type = "unknown"
        try:
            job = parse_job(str(message))
            content_type = job.content_type
            correlation_id_ctx.set(job.correlation_id or "-")
            await process_job_message(
                job,
                blob_service_client=blob_service_client,
                service_bus_client=service_bus_client,
                parent_context=extract_trace_context(message.application_properties),
            )
            await receiver.complete_message(message)
            MESSAGES_PROCESSED_TOTAL.labels(outcome="success", content_type=content_type).inc()
        except PermanentProcessingError as exc:
            logger.error(
                "message_dead_lettered",
                extra={
                    "fields": {
                        "doc_id": job.doc_id if job else None,
                        "reason": str(exc),
                        "delivery_count": message.delivery_count,
                    }
                },
            )
            await self._publish_failure_event(service_bus_client, job, str(exc))
            await receiver.dead_letter_message(message, reason=type(exc).__name__, error_description=str(exc))
            MESSAGES_PROCESSED_TOTAL.labels(outcome="dead_lettered", content_type=content_type).inc()
        except Exception as exc:  # noqa: BLE001 - top-level guard for the consumer loop
            # Transient failure: if we've exhausted retries, dead-letter;
            # otherwise abandon so Service Bus redelivers the message.
            delivery_count = message.delivery_count or 0
            logger.exception(
                "message_processing_failed",
                extra={"fields": {"doc_id": job.doc_id if job else None, "delivery_count": delivery_count}},
            )
            if delivery_count >= settings.max_delivery_attempts:
                await self._publish_failure_event(service_bus_client, job, str(exc))
                await receiver.dead_letter_message(
                    message, reason="MaxDeliveryAttemptsExceeded", error_description=str(exc)
                )
                MESSAGES_PROCESSED_TOTAL.labels(outcome="dead_lettered", content_type=content_type).inc()
            else:
                await receiver.abandon_message(message)
                MESSAGES_PROCESSED_TOTAL.labels(outcome="retried", content_type=content_type).inc()

    async def consume(
        self,
        receiver: ServiceBusReceiver,
        *,
        blob_service_client: BlobServiceClient,
        service_bus_client: ServiceBusClient,
    ) -> None:
        """Receive loop: keep at most `max_concurrency` handlers in flight."""
        while not self.shutdown_event.is_set():
            self.heartbeat()
            free = self.free_slots()
            if free == 0:
                # Wait (bounded, so the heartbeat stays fresh) for a slot.
                await asyncio.wait(
                    self._in_flight_tasks,
                    timeout=settings.max_wait_time_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                continue
            try:
                messages = await receiver.receive_messages(
                    max_message_count=min(free, settings.max_message_count),
                    max_wait_time=settings.max_wait_time_seconds,
                )
            except ServiceBusError:
                logger.exception("receive_messages_failed")
                await asyncio.sleep(1)
                continue

            for message in messages:
                task = asyncio.create_task(
                    self._handle_message(
                        receiver,
                        message,
                        blob_service_client=blob_service_client,
                        service_bus_client=service_bus_client,
                    )
                )
                self._in_flight_tasks.add(task)
                task.add_done_callback(self._in_flight_tasks.discard)

        # Drain: wait for all in-flight message handlers to finish before
        # releasing the receiver/connections.
        if self._in_flight_tasks:
            logger.info(
                "draining_in_flight_tasks",
                extra={"fields": {"count": len(self._in_flight_tasks)}},
            )
            await asyncio.gather(*self._in_flight_tasks, return_exceptions=True)

    def connect_retry_delay(self, attempt: int) -> float:
        """Exponential backoff for the `attempt`-th consecutive failure (1-based)."""
        return min(
            settings.connect_retry_initial_seconds * 2 ** (attempt - 1),
            settings.connect_retry_max_seconds,
        )

    async def _wait_for_shutdown(self, timeout: float) -> None:
        """Sleep for `timeout` seconds, returning early on shutdown."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(self.shutdown_event.wait(), timeout)

    async def serve(
        self,
        *,
        blob_service_client: BlobServiceClient,
        service_bus_client: ServiceBusClient,
        lock_renewer: AutoLockRenewer,
    ) -> None:
        """Open the queue receiver and consume until shutdown, reconnecting with
        backoff when Storage or Service Bus is unavailable, so a dependency that
        is still starting delays the worker instead of crashing it."""
        attempt = 0
        while not self.shutdown_event.is_set():
            # The process is healthy while retrying, just not ready.
            self.heartbeat()
            try:
                await ensure_container(blob_service_client, settings.results_container_name)
                async with service_bus_client.get_queue_receiver(
                    queue_name=settings.service_bus_queue_name,
                    prefetch_count=settings.prefetch_count,
                    # The aio client annotates this with the *sync* AutoLockRenewer
                    # (SDK typing bug); its docstring and runtime expect the aio one.
                    auto_lock_renewer=lock_renewer,  # pyright: ignore[reportArgumentType]
                ) as receiver:
                    attempt = 0
                    self.receiver_ready = True
                    logger.info(
                        "worker_started",
                        extra={
                            "fields": {
                                "queue": settings.service_bus_queue_name,
                                "max_concurrency": settings.max_concurrency,
                                "prefetch_count": settings.prefetch_count,
                            }
                        },
                    )
                    await self.consume(
                        receiver,
                        blob_service_client=blob_service_client,
                        service_bus_client=service_bus_client,
                    )
            except (ServiceBusError, AzureError) as exc:
                attempt += 1
                delay = self.connect_retry_delay(attempt)
                logger.warning(
                    "worker_connect_failed",
                    exc_info=True,
                    extra={
                        "fields": {
                            "attempt": attempt,
                            "retry_in_seconds": delay,
                            "error_type": type(exc).__name__,
                        }
                    },
                )
                await self._wait_for_shutdown(delay)
            finally:
                self.receiver_ready = False

    async def run(self) -> None:
        factory = AzureClientFactory()
        try:
            async with (
                factory.blob_service_client(
                    account_url=settings.storage_account_url,
                    connection_string=settings.azure_storage_connection_string,
                ) as blob_service_client,
                factory.service_bus_client(
                    fully_qualified_namespace=settings.service_bus_namespace,
                    connection_string=settings.service_bus_connection_string,
                ) as service_bus_client,
                AutoLockRenewer(max_lock_renewal_duration=settings.max_lock_renewal_seconds) as lock_renewer,
            ):
                await self.serve(
                    blob_service_client=blob_service_client,
                    service_bus_client=service_bus_client,
                    lock_renewer=lock_renewer,
                )
        finally:
            self.receiver_ready = False
            await factory.close()
        logger.info("worker_stopped")
