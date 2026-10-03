/**
 * Settings common to every service: Azure access, shared resource names, and
 * logging/telemetry. Each service spreads `azureServiceSettings` into its own
 * shape and adds only its own fields.
 *
 * Every field is read from the environment variable of the same name in
 * UPPER_SNAKE_CASE (`maxConcurrency` <- `MAX_CONCURRENCY`). An unset or empty
 * variable takes the default.
 *
 * When `storageAccountUrl` / `serviceBusNamespace` are set, services
 * authenticate with Entra ID (Workload Identity, see `azure-clients`).
 * Otherwise they fall back to connection strings; the storage default is the
 * well-known Azurite (local Storage emulator) development account.
 */

import { z } from 'zod';

export const AZURITE_CONNECTION_STRING =
  'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;' +
  'AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;' +
  'BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;';

export const azureServiceSettings = {
  // Azure Blob Storage
  storageAccountUrl: z.string().optional(),
  /** Local-dev fallback used only when STORAGE_ACCOUNT_URL is unset. */
  azureStorageConnectionString: z.string().default(AZURITE_CONNECTION_STRING),
  blobContainerName: z.string().default('raw-documents'),
  resultsContainerName: z.string().default('extraction-results'),

  // Azure Service Bus. `serviceBusNamespace` is the fully qualified namespace
  // (e.g. sb-x.servicebus.windows.net) used with Entra ID auth.
  serviceBusNamespace: z.string().optional(),
  /** Local-dev fallback used only when SERVICE_BUS_NAMESPACE is unset. */
  serviceBusConnectionString: z
    .string()
    .default('Endpoint=sb://placeholder.servicebus.windows.net/;SharedAccessKeyName=fake;SharedAccessKey=fake'),
  // The worker publishes completion events here; the document service consumes them.
  serviceBusResultsTopicName: z.string().default('extraction-results'),

  // Logging / telemetry. Services override the default service name.
  logLevel: z.string().default('INFO'),
  azureSdkLogLevel: z.string().default('WARNING'),
  otelServiceName: z.string().default('docprocessor'),
} satisfies z.ZodRawShape;

/** `maxConcurrency` -> `MAX_CONCURRENCY`. */
export function envName(field: string): string {
  return field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Read `shape`'s fields from the environment and validate them. Throws an
 * error naming the offending variables, so a misconfigured pod fails at
 * startup instead of at first use.
 */
export function loadSettings<S extends z.ZodRawShape>(
  shape: S,
  source: NodeJS.ProcessEnv = process.env,
): z.output<z.ZodObject<S>> {
  const input: Record<string, string> = {};
  for (const field of Object.keys(shape)) {
    const value = source[envName(field)];
    if (value !== undefined && value !== '') {
      input[field] = value;
    }
  }
  const result = z.object(shape).safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const field = String(issue.path[0] ?? '');
      return `${envName(field)}: ${issue.message}`;
    });
    throw new Error(`invalid configuration: ${problems.join('; ')}`);
  }
  return result.data;
}

/**
 * Load `.env` from the working directory into `process.env`, if present.
 * Variables already set in the environment win.
 */
export function loadDotEnv(path = '.env'): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
