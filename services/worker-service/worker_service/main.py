"""Worker microservice for the SaaS document processing platform.

This module is the composition root: it configures logging/telemetry, starts
the metrics and health servers, installs signal handlers, and runs the
consumer. Package layout:

  config.py      Settings (environment variables)
  consumer.py    Worker: Service Bus receive loop, concurrency cap, retries, shutdown
  processing.py  one job: download -> extract -> upload result -> publish event
  extractors.py  text extraction per content type (PDF, DOCX, OCR for images)
  health.py      /healthz and /readyz (aiohttp, on the worker's event loop)
  metrics.py     Prometheus counters and histograms

Responsibilities:
  * Consume extraction-job messages from an Azure Service Bus queue, with
    bounded concurrency and automatic message-lock renewal.
  * Download the source document from Azure Blob Storage.
  * Extract text (PDF via PyMuPDF, DOCX via python-docx, images via
    pytesseract OCR).
  * Upload the extraction result as JSON back to Blob Storage.
  * Publish a completion event (succeeded or failed) onto a Service Bus topic
    for the downstream AI analysis pipeline to consume.
  * Dead-letter messages that fail permanently.
  * Support graceful shutdown (SIGTERM) that drains in-flight work.
  * Emit OpenTelemetry spans (continuing the upload request's trace),
    Prometheus metrics, and liveness/readiness endpoints.

Run locally (from the repository root) with:
    uv run python -m worker_service.main
"""

from __future__ import annotations

import asyncio
import signal

from aiohttp import web
from prometheus_client import start_http_server

from docprocessor_shared.structured_logging import configure_logging
from docprocessor_shared.telemetry import configure_telemetry
from worker_service.config import settings
from worker_service.consumer import Worker
from worker_service.health import build_health_app

logger = configure_logging(settings.log_level, "worker_service", azure_sdk_level=settings.azure_sdk_log_level)
configure_telemetry(service_name=settings.otel_service_name)


async def main() -> None:
    # Expose Prometheus metrics (messages_processed_total, extraction_duration_seconds)
    # on a separate HTTP port, scraped by Azure Monitor managed Prometheus
    # via the PodMonitor in k8s/pod_monitor.yaml.
    start_http_server(settings.metrics_port)
    logger.info("metrics_server_started", extra={"fields": {"port": settings.metrics_port}})

    worker = Worker()
    health_runner = web.AppRunner(build_health_app(worker), access_log=None)
    await health_runner.setup()
    await web.TCPSite(health_runner, "0.0.0.0", settings.health_port).start()
    logger.info("health_server_started", extra={"fields": {"port": settings.health_port}})

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, worker.request_shutdown)

    try:
        await worker.run()
    finally:
        await health_runner.cleanup()


def run() -> None:
    """Console entry point (`worker-service`, or `python -m worker_service.main`)."""
    try:
        asyncio.run(main())
    except Exception:  # noqa: BLE001 - log any crash, then exit non-zero
        # Log through `logging` (not just the interpreter's stderr traceback)
        # so the crash reaches the OTLP log export; the provider flushes at exit.
        logger.critical("worker_crashed", exc_info=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    run()
