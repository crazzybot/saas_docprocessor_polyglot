"""Settings for the worker service.

All configuration comes from environment variables (see k8s/configmap.yaml);
Azure access uses Workload Identity, so no secrets are needed in AKS.
"""

from __future__ import annotations

from typing import Self

from pydantic import Field, model_validator

from docprocessor_shared.settings import AzureServiceSettings


class Settings(AzureServiceSettings):
    """Azure access, container/topic names and logging come from
    `AzureServiceSettings`; only worker settings are declared here."""

    service_bus_queue_name: str = Field(default="extraction-jobs")

    # Concurrency / delivery. Prefetched messages sit in a local buffer with
    # their lock ticking and are NOT lock-renewed until handed to the app, so
    # prefetch defaults to 0; scale throughput with MAX_CONCURRENCY and KEDA.
    max_concurrency: int = Field(default=4, ge=1)
    prefetch_count: int = Field(default=0, ge=0)
    max_message_count: int = Field(default=10, ge=1)
    max_wait_time_seconds: int = Field(default=5, ge=1)
    max_delivery_attempts: int = Field(default=3, ge=1)
    max_lock_renewal_seconds: int = Field(default=600, ge=1)
    # Deadline for one job's download -> extract -> upload; past it the
    # document is reported failed and the message dead-lettered. Must be
    # below MAX_LOCK_RENEWAL_SECONDS so the job times out while its message
    # is still locked, instead of losing the lock and being redelivered.
    processing_timeout_seconds: int = Field(default=300, ge=1)

    metrics_port: int = Field(default=9100)
    health_port: int = Field(default=8080)
    health_stale_after_seconds: int = Field(default=60, ge=1)
    otel_service_name: str = Field(default="worker-service")

    # Startup/reconnect backoff when Storage or Service Bus is unreachable
    # (e.g. the local emulator is still creating its queues). Retries until
    # shutdown; /readyz reports not-ready meanwhile.
    connect_retry_initial_seconds: float = Field(default=1.0, gt=0)
    connect_retry_max_seconds: float = Field(default=30.0, gt=0)

    @model_validator(mode="after")
    def _timeout_fits_in_lock_renewal(self) -> Self:
        if self.processing_timeout_seconds >= self.max_lock_renewal_seconds:
            raise ValueError("PROCESSING_TIMEOUT_SECONDS must be less than MAX_LOCK_RENEWAL_SECONDS")
        return self


settings = Settings()
