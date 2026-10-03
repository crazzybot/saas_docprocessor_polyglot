"""Structured JSON logging shared by every microservice.

Each log line is a single JSON object carrying the current correlation ID
(set per request / per message via `correlation_id_ctx`), any trace context
added by `shared.telemetry.log_with_trace`, and any structured fields passed
via `extra={"fields": {...}}`.
"""

from __future__ import annotations

import contextvars
import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

# A ContextVar lets every log line emitted while handling a request/message
# carry that unit of work's correlation ID without threading it through every
# function signature. asyncio tasks copy the context at creation, so values
# set inside a task stay local to it.
correlation_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar("correlation_id", default="-")


class JsonFormatter(logging.Formatter):
    """Renders log records as single-line JSON for ingestion by log
    aggregators (Azure Log Analytics / Container Insights)."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "correlation_id": correlation_id_ctx.get(),
        }
        trace_context = getattr(record, "trace_context", None)
        if trace_context:
            payload.update(trace_context)
        fields = getattr(record, "fields", None)
        if fields:
            payload.update(fields)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str, logger_name: str, *, azure_sdk_level: str = "WARNING") -> logging.Logger:
    """Configure root logging once, at process start, with JSON output.

    The Azure SDK logs every HTTP request/response and AMQP link state change
    at INFO, which drowns out application logs, so its `azure` logger
    hierarchy gets its own (by default quieter) level.
    """
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())
    logging.getLogger("azure").setLevel(azure_sdk_level.upper())
    return logging.getLogger(logger_name)
