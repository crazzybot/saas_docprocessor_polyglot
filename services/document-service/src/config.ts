/**
 * Settings for the document service.
 *
 * All configuration comes from environment variables so the same container
 * image runs unmodified across dev/staging/prod. In AKS these are injected via
 * the ConfigMap (see k8s/configmap.yaml); no secrets are needed because Azure
 * access (Storage, Service Bus, PostgreSQL) uses Workload Identity.
 */

import { azureServiceSettings, loadSettings } from '@docprocessor/shared';
import { z } from 'zod';

export const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Injection token for the `Settings` object. */
export const SETTINGS = Symbol('Settings');

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const positive = () => z.coerce.number().positive();

export const documentServiceSettings = {
  ...azureServiceSettings,

  // Lifecycle events (document.uploaded/updated/deleted) are published here
  // through the transactional outbox. A filtered subscription auto-forwards
  // document.uploaded to the worker's extraction-jobs queue.
  serviceBusEventsTopicName: z.string().default('document-events'),
  // This service's subscription on the worker's completion-events topic.
  serviceBusResultsSubscriptionName: z.string().default('document-service'),

  // PostgreSQL catalog. In Azure, set POSTGRES_ENTRA_AUTH=true and give a
  // DSN without a password (user = the managed identity's PostgreSQL role);
  // an Entra ID access token is then fetched for every new connection.
  databaseUrl: z.string().default('postgresql://docprocessor:docprocessor@127.0.0.1:5432/docprocessor'),
  postgresEntraAuth: z.stringbool().default(false),
  dbPoolMinSize: int(0).default(1),
  dbPoolMaxSize: int(1).default(10),
  dbCommandTimeoutSeconds: positive().default(10),
  /** Apply pending schema migrations at startup (under an advisory lock). */
  dbRunMigrations: z.stringbool().default(true),

  // Background work.
  outboxBatchSize: int(1, 100).default(50),
  outboxPollIntervalSeconds: positive().default(1),
  consumerMaxWaitTimeSeconds: int(1).default(5),
  consumerMaxDeliveryAttempts: int(1).default(5),
  maintenanceIntervalSeconds: int(1).default(300),
  tombstoneRetentionHours: int(1).default(168),
  outboxRetentionHours: int(1).default(24),

  // Microsoft Entra ID auth. Each customer is its own Entra ID tenant; the
  // token's `tid` claim is the tenant ID and must be on the allow-list.
  azureAdAudience: z.string().default('api://saas-docprocessor'),
  azureAdJwksUrl: z.string().default('https://login.microsoftonline.com/common/discovery/v2.0/keys'),
  /** Comma-separated customer tenant IDs. Empty rejects every token (fail closed). */
  azureAdAllowedTenantIds: z.string().default(''),
  /** Delegated scope (scp) or app role (roles) required by every endpoint. Empty disables the check. */
  azureAdRequiredScope: z.string().default(''),
  /** Disable for local development only. */
  authEnabled: z.stringbool().default(true),

  // Upload constraints
  maxUploadSizeMb: int(1).default(25),
  maxFilenameLength: int(16).default(255),

  // Listing
  defaultPageSize: int(1).default(20),
  maxPageSize: int(1).default(100),

  port: int(1, 65535).default(8000),
  otelServiceName: z.string().default('document-service'),
};

export type RawSettings = z.output<z.ZodObject<typeof documentServiceSettings>>;

export interface Settings extends RawSettings {
  readonly allowedTenantIds: ReadonlySet<string>;
  readonly maxUploadSizeBytes: number;
  readonly allowedContentTypes: readonly string[];
}

export function loadDocumentServiceSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  return withDerived(loadSettings(documentServiceSettings, env));
}

export function withDerived(raw: RawSettings): Settings {
  return {
    ...raw,
    allowedTenantIds: new Set(
      raw.azureAdAllowedTenantIds
        .split(',')
        .map((tid) => tid.trim().toLowerCase())
        .filter(Boolean),
    ),
    maxUploadSizeBytes: raw.maxUploadSizeMb * 1024 * 1024,
    allowedContentTypes: ['application/pdf', DOCX_CONTENT_TYPE, 'image/png', 'image/jpeg'],
  };
}
