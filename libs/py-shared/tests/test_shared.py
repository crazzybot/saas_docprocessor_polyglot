from __future__ import annotations

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest
from azure.core.exceptions import ResourceExistsError

from docprocessor_shared.azure_clients import ensure_container
from docprocessor_shared.settings import AZURITE_CONNECTION_STRING, AzureServiceSettings
from docprocessor_shared.structured_logging import correlation_id_ctx
from docprocessor_shared.telemetry import _StructuredLoggingHandler, extract_trace_context


def _blob_service(*, exists: bool, create_side_effect: Exception | None = None) -> tuple[MagicMock, MagicMock]:
    container = MagicMock()
    container.exists = AsyncMock(return_value=exists)
    container.create_container = AsyncMock(side_effect=create_side_effect)
    service = MagicMock()
    service.get_container_client.return_value = container
    return service, container


async def test_ensure_container_creates_missing_container() -> None:
    service, container = _blob_service(exists=False)
    await ensure_container(service, "results")
    container.create_container.assert_awaited_once()


async def test_ensure_container_tolerates_losing_the_create_race() -> None:
    service, container = _blob_service(exists=False, create_side_effect=ResourceExistsError("exists"))
    await ensure_container(service, "results")  # must not raise
    container.create_container.assert_awaited_once()


async def test_ensure_container_skips_existing_container() -> None:
    service, container = _blob_service(exists=True)
    await ensure_container(service, "results")
    container.create_container.assert_not_called()


def test_extract_trace_context_accepts_bytes_properties() -> None:
    traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    context = extract_trace_context({b"traceparent": traceparent.encode(), b"tenant_id": b"t"})
    span_context = next(iter(context.values())).get_span_context()
    assert format(span_context.trace_id, "032x") == "0af7651916cd43dd8448eb211c80319c"


def test_otlp_log_attributes_flatten_structured_fields() -> None:
    record = logging.LogRecord("worker_service", logging.INFO, __file__, 1, "job_done", None, None)
    record.fields = {"doc_id": "d1", "attempt": 2, "tags": ["a"], "skipped": None}
    record.trace_context = {"trace_id": "t", "span_id": "s", "tenant_id": "acme"}
    token = correlation_id_ctx.set("corr-1")
    try:
        attributes = _StructuredLoggingHandler._get_attributes(record)
    finally:
        correlation_id_ctx.reset(token)

    assert attributes["doc_id"] == "d1"
    assert attributes["attempt"] == 2
    assert attributes["tags"] == "['a']"
    assert attributes["tenant_id"] == "acme"
    assert attributes["correlation_id"] == "corr-1"
    for dropped in ("fields", "trace_context", "trace_id", "span_id", "skipped"):
        assert dropped not in attributes


def test_settings_read_the_shared_azure_base(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("STORAGE_ACCOUNT_URL", "https://acct.blob.core.windows.net")
    monkeypatch.setenv("RESULTS_CONTAINER_NAME", "results-x")
    settings = AzureServiceSettings(_env_file=None)

    assert settings.storage_account_url == "https://acct.blob.core.windows.net"
    assert settings.results_container_name == "results-x"
    assert settings.azure_storage_connection_string == AZURITE_CONNECTION_STRING
