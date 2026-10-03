"""OpenTelemetry + structured logging helpers for the Python services.

The TypeScript services follow the same conventions (libs/ts-shared): JSON
log fields, span names, and W3C trace-context propagation through message
application properties.

Usage:
    from docprocessor_shared.telemetry import configure_telemetry, get_tracer, log_with_trace

    configure_telemetry(service_name="worker-service")
    tracer = get_tracer(__name__)

    with tracer.start_as_current_span("do-work"):
        log_with_trace(logger, logging.INFO, "doing work", extra={"doc_id": doc_id})
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from typing import Any

from opentelemetry import propagate, trace
from opentelemetry.context import Context
from opentelemetry.sdk._logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.resources import SERVICE_NAME, Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, ConsoleSpanExporter
from opentelemetry.trace import Tracer
from opentelemetry.util.types import Attributes

from docprocessor_shared.structured_logging import correlation_id_ctx

# Track whether configure_telemetry() has already run to avoid double-init
# (double-initialising a TracerProvider raises/duplicates exporters).
_TELEMETRY_CONFIGURED: bool = False


def configure_telemetry(
    service_name: str,
    *,
    otlp_endpoint: str | None = None,
    console_export: bool = False,
) -> None:
    """Configure a process-wide OpenTelemetry TracerProvider.

    Exports spans to an OTLP-compatible collector (e.g. the Azure Monitor
    OpenTelemetry Distro / an OpenTelemetry Collector configured with the
    Azure Monitor exporter, or Application Insights via the OTLP ingestion
    endpoint). Falls back to a console exporter for local development if no
    endpoint is configured. With OTEL_LOGS_EXPORTER=otlp, stdlib log records
    are also exported to the same endpoint.

    Args:
        service_name: Logical service name attached to every span (used for
            grouping traces in Azure Monitor / Application Insights).
        otlp_endpoint: OTLP gRPC/HTTP endpoint. Defaults to the
            OTEL_EXPORTER_OTLP_ENDPOINT env var (commonly pointed at the
            Azure Monitor OpenTelemetry Collector sidecar or App Insights
            connection string proxy).
        console_export: If True, also emit spans to stdout for local debug.
    """
    global _TELEMETRY_CONFIGURED
    if _TELEMETRY_CONFIGURED:
        return

    resource = Resource.create({SERVICE_NAME: service_name})
    provider = TracerProvider(resource=resource)

    endpoint = otlp_endpoint or os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if endpoint:
        # Imported lazily so environments without the OTLP exporter package
        # installed can still use the console-only fallback.
        from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
            OTLPSpanExporter,
        )

        otlp_exporter = OTLPSpanExporter(endpoint=endpoint, insecure=endpoint.startswith("http://"))
        provider.add_span_processor(BatchSpanProcessor(otlp_exporter))
        # Opt-in: in AKS, Container Insights already collects stdout, so
        # exporting logs too would duplicate them. The local stack enables it
        # so logs show up in the Aspire Dashboard next to the traces.
        if os.environ.get("OTEL_LOGS_EXPORTER", "none").lower() == "otlp":
            _configure_log_export(resource, endpoint)

    if console_export or not endpoint:
        provider.add_span_processor(BatchSpanProcessor(ConsoleSpanExporter()))

    trace.set_tracer_provider(provider)
    _TELEMETRY_CONFIGURED = True


_PRIMITIVE_ATTRIBUTE_TYPES = (str, bool, int, float)


class _StructuredLoggingHandler(LoggingHandler):
    """OTLP log handler that keeps our structured fields.

    The SDK handler turns every `extra` key into a log attribute but drops
    dict values, which is how `fields` and `trace_context` arrive. Flatten
    both into top-level attributes and add the correlation ID.
    """

    @staticmethod
    def _get_attributes(record: logging.LogRecord) -> Attributes:
        attributes = dict(LoggingHandler._get_attributes(record) or {})
        # `log_with_trace` nests its fields under `trace_context`, beside
        # trace_id/span_id, which the SDK already records natively.
        trace_fields = dict(attributes.pop("trace_context", None) or {})
        trace_fields.pop("trace_id", None)
        trace_fields.pop("span_id", None)
        fields = {**trace_fields, **(attributes.pop("fields", None) or {})}
        for key, value in fields.items():
            if value is None:
                continue
            attributes[key] = value if isinstance(value, _PRIMITIVE_ATTRIBUTE_TYPES) else str(value)
        attributes["correlation_id"] = correlation_id_ctx.get()
        return attributes


def _is_not_exporter_log(record: logging.LogRecord) -> bool:
    # The exporter logs its own failures; shipping those through itself would
    # feed back into the queue it is failing to drain.
    return not record.name.startswith(("opentelemetry", "grpc"))


def _configure_log_export(resource: Resource, endpoint: str) -> None:
    """Also ship stdlib log records over OTLP, alongside the stdout JSON handler
    that `configure_logging` installs (call that first: it clears root handlers)."""
    from opentelemetry.exporter.otlp.proto.grpc._log_exporter import OTLPLogExporter

    logger_provider = LoggerProvider(resource=resource)
    logger_provider.add_log_record_processor(
        BatchLogRecordProcessor(OTLPLogExporter(endpoint=endpoint, insecure=endpoint.startswith("http://")))
    )
    handler = _StructuredLoggingHandler(logger_provider=logger_provider)
    handler.addFilter(_is_not_exporter_log)
    logging.getLogger().addHandler(handler)


def inject_trace_context() -> dict[str, str]:
    """Serialise the current trace context (W3C `traceparent`/`tracestate`)
    into a string dict suitable for message application properties, so a
    consumer can continue the same distributed trace."""
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return carrier


def extract_trace_context(carrier: Mapping[str | bytes, Any] | None) -> Context:
    """Rebuild a parent trace context from message application properties.

    Service Bus may deliver property keys/values as bytes, so both are
    normalised to str before extraction.
    """
    normalised: dict[str, str] = {}
    for key, value in (carrier or {}).items():
        str_key = key.decode() if isinstance(key, bytes) else str(key)
        str_value = value.decode() if isinstance(value, bytes) else str(value)
        normalised[str_key] = str_value
    return propagate.extract(normalised)


def get_tracer(name: str) -> Tracer:
    """Return a named tracer bound to the configured global TracerProvider."""
    return trace.get_tracer(name)


def log_with_trace(
    logger: logging.Logger,
    level: int,
    message: str,
    *,
    extra: Mapping[str, Any] | None = None,
) -> None:
    """Emit a structured log record enriched with the current trace/span IDs.

    This lets log aggregation systems (e.g. Azure Log Analytics) correlate
    log lines with distributed traces by matching trace_id/span_id fields.
    """
    span = trace.get_current_span()
    span_context = span.get_span_context()
    trace_id = format(span_context.trace_id, "032x") if span_context.trace_id else None
    span_id = format(span_context.span_id, "016x") if span_context.span_id else None

    log_extra: dict[str, Any] = dict(extra or {})
    log_extra["trace_id"] = trace_id
    log_extra["span_id"] = span_id

    logger.log(level, message, extra={"trace_context": log_extra})
