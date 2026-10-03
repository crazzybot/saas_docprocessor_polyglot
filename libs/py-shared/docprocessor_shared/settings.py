"""Settings common to every service: Azure access, shared resource names,
and logging/telemetry. Each service subclasses `AzureServiceSettings` and
adds only its own fields.

When `storage_account_url` / `service_bus_namespace` are set, services
authenticate with Entra ID (Workload Identity, see `azure_clients`).
Otherwise they fall back to connection strings; the storage default is the
well-known Azurite (local Storage emulator) development account.
"""

from __future__ import annotations

from typing import Final

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

AZURITE_CONNECTION_STRING: Final[str] = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"
)


class AzureServiceSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Azure Blob Storage
    storage_account_url: str | None = Field(default=None)
    azure_storage_connection_string: str = Field(
        default=AZURITE_CONNECTION_STRING,
        description="Local-dev fallback used only when STORAGE_ACCOUNT_URL is unset.",
    )
    blob_container_name: str = Field(default="raw-documents")
    results_container_name: str = Field(default="extraction-results")

    # Azure Service Bus. `service_bus_namespace` is the fully qualified
    # namespace (e.g. sb-x.servicebus.windows.net) used with Entra ID auth.
    service_bus_namespace: str | None = Field(default=None)
    service_bus_connection_string: str = Field(
        default="Endpoint=sb://placeholder.servicebus.windows.net/;SharedAccessKeyName=fake;SharedAccessKey=fake",
        description="Local-dev fallback used only when SERVICE_BUS_NAMESPACE is unset.",
    )
    # The worker publishes completion events here; the document service consumes them.
    service_bus_results_topic_name: str = Field(default="extraction-results")

    # Logging / telemetry. Services override the default service name.
    log_level: str = Field(default="INFO")
    azure_sdk_log_level: str = Field(default="WARNING")
    otel_service_name: str = Field(default="docprocessor")
