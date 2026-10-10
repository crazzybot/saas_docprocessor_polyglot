from __future__ import annotations

import asyncio
import io
import json
from unittest.mock import AsyncMock, MagicMock

import fitz
import pytest
from azure.core.exceptions import ResourceNotFoundError, ServiceRequestError
from azure.servicebus.exceptions import ServiceBusError
from docx import Document

from docprocessor_shared.contracts import DocumentUploadedEvent
from worker_service import consumer, extractors, processing
from worker_service.config import settings

TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"


def _job(**overrides: object) -> dict[str, object]:
    job: dict[str, object] = {
        "doc_id": "doc-1",
        "tenant_id": "tenant-1",
        "filename": "my report.pdf",
        "content_type": "application/pdf",
        "blob_name": "tenant-1/doc-1/my report.pdf",
        "blob_url": "https://acct.blob.core.windows.net/raw-documents/tenant-1/doc-1/my%20report.pdf",
        "blob_container": "raw-documents",
        "correlation_id": "corr-1",
    }
    job.update(overrides)
    return job


def _event(**overrides: object) -> DocumentUploadedEvent:
    return DocumentUploadedEvent.model_validate(_job(**overrides))


def _message(body: str, *, delivery_count: int = 0) -> MagicMock:
    message = MagicMock()
    message.__str__.return_value = body
    message.delivery_count = delivery_count
    message.application_properties = {b"traceparent": TRACEPARENT.encode()}
    return message


def _receiver() -> MagicMock:
    receiver = MagicMock()
    receiver.complete_message = AsyncMock()
    receiver.dead_letter_message = AsyncMock()
    receiver.abandon_message = AsyncMock()
    return receiver


# --------------------------------------------------------------------------
# Blob name resolution (shared contract, as the worker uses it)
# --------------------------------------------------------------------------
def test_blob_name_field_is_preferred() -> None:
    assert _event().resolve_blob_name("raw-documents") == "tenant-1/doc-1/my report.pdf"


def test_legacy_blob_url_is_percent_decoded() -> None:
    assert _event(blob_name=None).resolve_blob_name("raw-documents") == "tenant-1/doc-1/my report.pdf"


def test_legacy_blob_url_with_unicode_round_trips() -> None:
    job = _event(
        blob_name=None,
        blob_url="https://acct.blob.core.windows.net/raw-documents/d/%D0%9E%D1%82%D1%87%D1%91%D1%82%25.pdf",
    )
    assert job.resolve_blob_name("raw-documents") == "d/Отчёт%.pdf"


def test_legacy_job_without_new_fields_is_accepted() -> None:
    """Messages queued by upload-service 1.x have no event_type/size_bytes."""
    job = processing.parse_job(json.dumps(_job()))
    assert job.event_type == "document.uploaded"
    assert job.size_bytes is None


# --------------------------------------------------------------------------
# Job parsing
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "body",
    ["not json", "[1, 2]", json.dumps({"doc_id": "d"}), json.dumps(_job(blob_name=None, blob_url=None))],
)
def test_malformed_jobs_are_permanent_failures(body: str) -> None:
    with pytest.raises(processing.PermanentProcessingError):
        processing.parse_job(body)


# --------------------------------------------------------------------------
# process_job_message
# --------------------------------------------------------------------------
async def test_missing_source_blob_is_permanent(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(processing, "download_blob", AsyncMock(side_effect=ResourceNotFoundError("gone")))

    with pytest.raises(processing.PermanentProcessingError, match="not found"):
        await processing.process_job_message(_event(), blob_service_client=MagicMock(), service_bus_client=MagicMock())


async def test_successful_job_publishes_succeeded_event(monkeypatch: pytest.MonkeyPatch) -> None:
    download = AsyncMock(return_value=b"%PDF")
    monkeypatch.setattr(processing, "download_blob", download)
    monkeypatch.setattr(processing, "extract_text", AsyncMock(return_value="hello"))
    monkeypatch.setattr(processing, "upload_result_json", AsyncMock(return_value="https://r/doc-1.json"))
    publish = AsyncMock()
    monkeypatch.setattr(processing, "publish_completion_event", publish)

    await processing.process_job_message(_event(), blob_service_client=MagicMock(), service_bus_client=MagicMock())

    assert download.call_args.args[2] == "tenant-1/doc-1/my report.pdf"
    assert publish.call_args.kwargs["status_value"] == "succeeded"


async def test_job_past_deadline_times_out_without_success_event(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "processing_timeout_seconds", 0.05)
    monkeypatch.setattr(processing, "download_blob", AsyncMock(return_value=b"%PDF"))

    async def slow_extract(*_: object) -> str:
        await asyncio.sleep(10)
        return "never"

    monkeypatch.setattr(processing, "extract_text", slow_extract)
    publish = AsyncMock()
    monkeypatch.setattr(processing, "publish_completion_event", publish)

    with pytest.raises(processing.ProcessingTimeoutError, match="timeout"):
        await asyncio.wait_for(
            processing.process_job_message(_event(), blob_service_client=MagicMock(), service_bus_client=MagicMock()),
            timeout=5,
        )
    publish.assert_not_called()


async def test_io_timeout_inside_deadline_stays_transient(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(processing, "download_blob", AsyncMock(side_effect=TimeoutError("socket timeout")))

    with pytest.raises(TimeoutError) as excinfo:
        await processing.process_job_message(_event(), blob_service_client=MagicMock(), service_bus_client=MagicMock())
    assert not isinstance(excinfo.value, processing.ProcessingTimeoutError)


def test_processing_timeout_must_be_below_lock_renewal() -> None:
    with pytest.raises(ValueError, match="PROCESSING_TIMEOUT_SECONDS"):
        type(settings)(processing_timeout_seconds=600, max_lock_renewal_seconds=600)


# --------------------------------------------------------------------------
# Message handling outcomes
# --------------------------------------------------------------------------
async def test_success_completes_message_with_trace_parent(monkeypatch: pytest.MonkeyPatch) -> None:
    process = AsyncMock()
    monkeypatch.setattr(consumer, "process_job_message", process)
    receiver = _receiver()

    await consumer.Worker()._handle_message(
        receiver, _message(json.dumps(_job())), blob_service_client=MagicMock(), service_bus_client=MagicMock()
    )

    receiver.complete_message.assert_awaited_once()
    parent = process.call_args.kwargs["parent_context"]
    span_context = next(iter(parent.values())).get_span_context()
    assert format(span_context.trace_id, "032x") == TRACEPARENT.split("-")[1]


async def test_malformed_message_is_dead_lettered_without_event(monkeypatch: pytest.MonkeyPatch) -> None:
    publish = AsyncMock()
    monkeypatch.setattr(consumer, "publish_completion_event", publish)
    receiver = _receiver()

    await consumer.Worker()._handle_message(
        receiver, _message("{broken"), blob_service_client=MagicMock(), service_bus_client=MagicMock()
    )

    receiver.dead_letter_message.assert_awaited_once()
    receiver.abandon_message.assert_not_called()
    publish.assert_not_called()


async def test_permanent_failure_publishes_failed_event_then_dead_letters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        consumer,
        "process_job_message",
        AsyncMock(side_effect=processing.PermanentProcessingError("corrupt file")),
    )
    publish = AsyncMock()
    monkeypatch.setattr(consumer, "publish_completion_event", publish)
    receiver = _receiver()

    await consumer.Worker()._handle_message(
        receiver, _message(json.dumps(_job())), blob_service_client=MagicMock(), service_bus_client=MagicMock()
    )

    assert publish.call_args.kwargs["status_value"] == "failed"
    assert publish.call_args.kwargs["error"] == "corrupt file"
    receiver.dead_letter_message.assert_awaited_once()


async def test_timed_out_job_publishes_failed_event_then_dead_letters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        consumer,
        "process_job_message",
        AsyncMock(side_effect=processing.ProcessingTimeoutError("processing exceeded 300s timeout")),
    )
    publish = AsyncMock()
    monkeypatch.setattr(consumer, "publish_completion_event", publish)
    receiver = _receiver()

    await consumer.Worker()._handle_message(
        receiver, _message(json.dumps(_job())), blob_service_client=MagicMock(), service_bus_client=MagicMock()
    )

    assert publish.call_args.kwargs["status_value"] == "failed"
    assert receiver.dead_letter_message.call_args.kwargs["reason"] == "ProcessingTimeoutError"
    receiver.abandon_message.assert_not_called()


async def test_failure_event_publish_error_still_dead_letters(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        consumer,
        "process_job_message",
        AsyncMock(side_effect=processing.PermanentProcessingError("corrupt file")),
    )
    monkeypatch.setattr(consumer, "publish_completion_event", AsyncMock(side_effect=ServiceBusError("topic down")))
    receiver = _receiver()

    await consumer.Worker()._handle_message(
        receiver, _message(json.dumps(_job())), blob_service_client=MagicMock(), service_bus_client=MagicMock()
    )

    receiver.dead_letter_message.assert_awaited_once()


async def test_transient_failure_is_abandoned_until_max_attempts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(consumer, "process_job_message", AsyncMock(side_effect=ServiceRequestError("network blip")))
    publish = AsyncMock()
    monkeypatch.setattr(consumer, "publish_completion_event", publish)
    worker = consumer.Worker()

    receiver = _receiver()
    await worker._handle_message(
        receiver,
        _message(json.dumps(_job()), delivery_count=0),
        blob_service_client=MagicMock(),
        service_bus_client=MagicMock(),
    )
    receiver.abandon_message.assert_awaited_once()
    publish.assert_not_called()

    receiver = _receiver()
    await worker._handle_message(
        receiver,
        _message(json.dumps(_job()), delivery_count=settings.max_delivery_attempts),
        blob_service_client=MagicMock(),
        service_bus_client=MagicMock(),
    )
    receiver.dead_letter_message.assert_awaited_once()
    assert publish.call_args.kwargs["status_value"] == "failed"


# --------------------------------------------------------------------------
# Concurrency + health
# --------------------------------------------------------------------------
async def test_consume_never_exceeds_max_concurrency(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "max_concurrency", 2)
    monkeypatch.setattr(settings, "max_wait_time_seconds", 1)
    worker = consumer.Worker()
    peak = 0

    async def slow_handle(*_: object, **__: object) -> None:
        nonlocal peak
        peak = max(peak, len(worker._in_flight_tasks))
        await asyncio.sleep(0.05)

    monkeypatch.setattr(worker, "_handle_message", slow_handle)
    requested: list[int] = []

    async def receive_messages(*, max_message_count: int, max_wait_time: int) -> list[MagicMock]:
        requested.append(max_message_count)
        if len(requested) >= 3:
            worker.request_shutdown()
        await asyncio.sleep(0)
        return [MagicMock() for _ in range(max_message_count)]

    receiver = MagicMock()
    receiver.receive_messages = receive_messages

    await asyncio.wait_for(
        worker.consume(receiver, blob_service_client=MagicMock(), service_bus_client=MagicMock()), timeout=5
    )

    assert requested[0] == 2
    assert all(count <= 2 for count in requested)
    assert peak == 2


@pytest.mark.parametrize(
    ("error", "expected_event", "has_traceback"),
    [
        (
            ServiceBusError(
                "The connection was inactive for more than the allowed 120000 milliseconds.",
                condition=b"amqp:connection:forced",
            ),
            "service_bus_connection_idle_closed",
            False,
        ),
        (ServiceBusError("something else broke"), "receive_messages_failed", True),
    ],
)
async def test_consume_logs_idle_close_without_traceback(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: ServiceBusError,
    expected_event: str,
    has_traceback: bool,
) -> None:
    monkeypatch.setattr(consumer.asyncio, "sleep", AsyncMock())
    worker = consumer.Worker()
    calls = 0

    async def receive_messages(**_: object) -> list[MagicMock]:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise error
        worker.request_shutdown()
        return []

    receiver = MagicMock()
    receiver.receive_messages = receive_messages

    with caplog.at_level("WARNING", logger=consumer.__name__):
        await worker.consume(receiver, blob_service_client=MagicMock(), service_bus_client=MagicMock())

    assert calls == 2  # the loop carried on after the error
    [record] = [r for r in caplog.records if r.getMessage() == expected_event]
    assert (record.exc_info is not None) == has_traceback


class _FailingReceiver:
    """Async context manager whose __aenter__ fails like an unready emulator."""

    def __init__(self, exc: Exception) -> None:
        self._exc = exc

    async def __aenter__(self) -> MagicMock:
        raise self._exc

    async def __aexit__(self, *_: object) -> None:
        return None


class _Receiver:
    async def __aenter__(self) -> MagicMock:
        return MagicMock()

    async def __aexit__(self, *_: object) -> None:
        return None


async def test_serve_retries_until_service_bus_is_available(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "connect_retry_initial_seconds", 0.01)
    monkeypatch.setattr(consumer, "ensure_container", AsyncMock())
    worker = consumer.Worker()
    service_bus_client = MagicMock()
    service_bus_client.get_queue_receiver.side_effect = [
        _FailingReceiver(ServiceBusError("connect refused")),
        _FailingReceiver(ServiceBusError("queue not found")),
        _Receiver(),
    ]
    ready_while_consuming: list[bool] = []

    async def consume(*_: object, **__: object) -> None:
        ready_while_consuming.append(worker.is_ready())
        worker.request_shutdown()

    monkeypatch.setattr(worker, "consume", consume)

    await asyncio.wait_for(
        worker.serve(
            blob_service_client=MagicMock(),
            service_bus_client=service_bus_client,
            lock_renewer=MagicMock(),
        ),
        timeout=5,
    )

    assert service_bus_client.get_queue_receiver.call_count == 3
    assert ready_while_consuming == [True]
    assert not worker.receiver_ready


async def test_serve_retries_when_storage_is_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "connect_retry_initial_seconds", 0.01)
    monkeypatch.setattr(consumer, "ensure_container", AsyncMock(side_effect=[ServiceRequestError("down"), None]))
    worker = consumer.Worker()
    service_bus_client = MagicMock()
    service_bus_client.get_queue_receiver.return_value = _Receiver()
    monkeypatch.setattr(worker, "consume", AsyncMock(side_effect=lambda *_, **__: worker.request_shutdown()))

    await asyncio.wait_for(
        worker.serve(
            blob_service_client=MagicMock(),
            service_bus_client=service_bus_client,
            lock_renewer=MagicMock(),
        ),
        timeout=5,
    )

    assert consumer.ensure_container.await_count == 2
    worker.consume.assert_awaited_once()


async def test_shutdown_interrupts_connect_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "connect_retry_initial_seconds", 60.0)
    monkeypatch.setattr(consumer, "ensure_container", AsyncMock())
    worker = consumer.Worker()
    service_bus_client = MagicMock()
    service_bus_client.get_queue_receiver.return_value = _FailingReceiver(ServiceBusError("down"))

    task = asyncio.create_task(
        worker.serve(
            blob_service_client=MagicMock(),
            service_bus_client=service_bus_client,
            lock_renewer=MagicMock(),
        )
    )
    await asyncio.sleep(0.05)  # now inside the 60s backoff
    worker.request_shutdown()

    await asyncio.wait_for(task, timeout=1)
    assert service_bus_client.get_queue_receiver.call_count == 1


def test_connect_retry_delay_backs_off_exponentially_to_a_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "connect_retry_initial_seconds", 1.0)
    monkeypatch.setattr(settings, "connect_retry_max_seconds", 30.0)
    worker = consumer.Worker()

    assert [worker.connect_retry_delay(n) for n in range(1, 8)] == [1, 2, 4, 8, 16, 30, 30]


def test_liveness_goes_stale_without_heartbeat(monkeypatch: pytest.MonkeyPatch) -> None:
    worker = consumer.Worker()
    worker.receiver_ready = True
    assert worker.is_live() and worker.is_ready()

    worker._last_heartbeat -= settings.health_stale_after_seconds + 1
    assert not worker.is_live()
    assert not worker.is_ready()


# --------------------------------------------------------------------------
# Extractors (real libraries, generated documents)
# --------------------------------------------------------------------------
async def test_pdf_extraction() -> None:
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), "Invoice 42")
    text = await extractors.extract_text("application/pdf", pdf.tobytes())
    assert "Invoice 42" in text


async def test_docx_extraction() -> None:
    document = Document()
    document.add_paragraph("Quarterly report")
    buffer = io.BytesIO()
    document.save(buffer)
    text = await extractors.extract_text(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer.getvalue()
    )
    assert text == "Quarterly report"


async def test_unsupported_content_type() -> None:
    with pytest.raises(extractors.UnsupportedContentTypeError):
        await extractors.extract_text("text/plain", b"x")
