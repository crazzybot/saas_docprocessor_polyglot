/**
 * Factory for the Azure SDK clients shared by every microservice.
 *
 * In AKS the services authenticate with Microsoft Entra ID via Azure AD
 * Workload Identity (`DefaultAzureCredential` picks up the federated token the
 * webhook projects into the pod), so no connection strings or keys are stored
 * in the cluster. Connection strings remain supported as a fallback for local
 * development against Azurite and the Service Bus emulator.
 */

import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import { BlobServiceClient } from '@azure/storage-blob';

import { getLogger } from './logging.js';

export type { TokenCredential };

const logger = getLogger('shared.azure_clients');

/** The HTTP status of an Azure SDK REST error, if it carries one. */
export function azureStatusCode(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' ? status : undefined;
}

const SDK_ERROR_NAMES = new Set(['RestError', 'ServiceBusError', 'MessagingError']);
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE']);

/**
 * Whether `error` came from an Azure SDK call or the network beneath it
 * (as opposed to a bug), so retrying later may succeed.
 */
export function isTransientAzureError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (SDK_ERROR_NAMES.has(error.name)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.has(code);
}

/**
 * Create a blob container if it does not exist.
 *
 * Safe under concurrency (several replicas starting at once): losing the
 * create race returns 409, which means the goal is met.
 */
export async function ensureContainer(blobServiceClient: BlobServiceClient, containerName: string): Promise<void> {
  const container = blobServiceClient.getContainerClient(containerName);
  if (await container.exists()) {
    return;
  }
  try {
    await container.create();
  } catch (error) {
    if (azureStatusCode(error) !== 409) {
      throw error;
    }
    logger.debug('container_already_exists', { container: containerName });
  }
}

/**
 * Builds Blob Storage and Service Bus clients, preferring Entra ID auth.
 * A single `DefaultAzureCredential` is created lazily and shared by every
 * client built from this factory.
 */
export class AzureClientFactory {
  private cachedCredential: TokenCredential | undefined;

  /** The shared Entra ID credential, e.g. for PostgreSQL token auth. */
  credential(): TokenCredential {
    this.cachedCredential ??= new DefaultAzureCredential();
    return this.cachedCredential;
  }

  blobServiceClient(options: { accountUrl?: string | undefined; connectionString: string }): BlobServiceClient {
    if (options.accountUrl) {
      logger.info('blob_client_auth', { mode: 'entra_id' });
      return new BlobServiceClient(options.accountUrl, this.credential());
    }
    logger.info('blob_client_auth', { mode: 'connection_string' });
    return BlobServiceClient.fromConnectionString(options.connectionString);
  }

  serviceBusClient(options: {
    fullyQualifiedNamespace?: string | undefined;
    connectionString: string;
  }): ServiceBusClient {
    if (options.fullyQualifiedNamespace) {
      logger.info('service_bus_client_auth', { mode: 'entra_id' });
      return new ServiceBusClient(options.fullyQualifiedNamespace, this.credential());
    }
    logger.info('service_bus_client_auth', { mode: 'connection_string' });
    return new ServiceBusClient(options.connectionString);
  }
}
