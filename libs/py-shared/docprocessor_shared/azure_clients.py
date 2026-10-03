"""Factory for async Azure SDK clients shared by every microservice.

In AKS the services authenticate with Microsoft Entra ID via Azure AD
Workload Identity (`DefaultAzureCredential` picks up the federated token the
webhook projects into the pod), so no connection strings or keys are stored
in the cluster. Connection strings remain supported as a fallback for local
development against Azurite / the Service Bus emulator.
"""

from __future__ import annotations

import logging

from azure.core.exceptions import ResourceExistsError
from azure.identity.aio import DefaultAzureCredential
from azure.servicebus.aio import ServiceBusClient
from azure.storage.blob.aio import BlobServiceClient

logger = logging.getLogger(__name__)


async def ensure_container(blob_service_client: BlobServiceClient, container_name: str) -> None:
    """Create a blob container if it does not exist.

    Safe under concurrency (several replicas starting at once): losing the
    create race raises ResourceExistsError, which means the goal is met.
    """
    container_client = blob_service_client.get_container_client(container_name)
    if await container_client.exists():
        return
    try:
        await container_client.create_container()
    except ResourceExistsError:
        logger.debug("container_already_exists", extra={"fields": {"container": container_name}})


class AzureClientFactory:
    """Builds Blob Storage / Service Bus clients, preferring Entra ID auth.

    A single `DefaultAzureCredential` is created lazily and shared by all
    clients built from this factory; call `close()` on shutdown.
    """

    def __init__(self) -> None:
        self._credential: DefaultAzureCredential | None = None

    def credential(self) -> DefaultAzureCredential:
        """The shared Entra ID credential, e.g. for PostgreSQL token auth."""
        if self._credential is None:
            self._credential = DefaultAzureCredential()
        return self._credential

    def blob_service_client(self, *, account_url: str | None, connection_string: str) -> BlobServiceClient:
        if account_url:
            logger.info("blob_client_auth", extra={"fields": {"mode": "entra_id"}})
            return BlobServiceClient(account_url=account_url, credential=self.credential())
        logger.info("blob_client_auth", extra={"fields": {"mode": "connection_string"}})
        return BlobServiceClient.from_connection_string(connection_string)

    def service_bus_client(self, *, fully_qualified_namespace: str | None, connection_string: str) -> ServiceBusClient:
        if fully_qualified_namespace:
            logger.info("service_bus_client_auth", extra={"fields": {"mode": "entra_id"}})
            return ServiceBusClient(
                fully_qualified_namespace=fully_qualified_namespace,
                credential=self.credential(),
            )
        logger.info("service_bus_client_auth", extra={"fields": {"mode": "connection_string"}})
        return ServiceBusClient.from_connection_string(connection_string)

    async def close(self) -> None:
        if self._credential is not None:
            await self._credential.close()
            self._credential = None
