"""Prometheus metrics, served on METRICS_PORT by `main.py` and scraped by
Azure Monitor managed Prometheus via the PodMonitor in k8s/pod_monitor.yaml."""

from __future__ import annotations

from typing import Final

from prometheus_client import Counter, Histogram

MESSAGES_PROCESSED_TOTAL: Final[Counter] = Counter(
    "messages_processed_total",
    "Total number of Service Bus messages processed, labelled by outcome.",
    labelnames=("outcome", "content_type"),
)
EXTRACTION_DURATION_SECONDS: Final[Histogram] = Histogram(
    "extraction_duration_seconds",
    "Time spent extracting text from a document, labelled by content type.",
    labelnames=("content_type",),
)
