/**
 * Runtime configuration, read from `/config.json` next to the bundle rather
 * than baked in at build time, so one image serves every environment: the
 * Compose stack mounts a local-mode file, and AKS mounts one from a ConfigMap.
 */

export interface LocalAuthConfig {
  /** Auth disabled on the API: the tenant is sent in `X-Tenant-ID`. */
  readonly mode: 'local';
  readonly defaultTenant: string;
}

export interface EntraAuthConfig {
  /** Sign in with Microsoft Entra ID and send the access token. */
  readonly mode: 'entra';
  /** The test client app registration (a SPA platform registration). */
  readonly clientId: string;
  /** `https://login.microsoftonline.com/organizations` for any work account. */
  readonly authority: string;
  /** e.g. `api://<API client ID>/Documents.Upload`. */
  readonly scopes: readonly string[];
}

export interface AppConfig {
  /** Origin of the document service; empty for the page's own origin. */
  readonly apiBaseUrl: string;
  readonly auth: LocalAuthConfig | EntraAuthConfig;
}

export class ConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new ConfigError(`${path}${key} must be a non-empty string`);
  }
  return value;
}

/** Validate the parsed `config.json`; throws `ConfigError` naming the bad field. */
export function parseConfig(raw: unknown): AppConfig {
  if (!isRecord(raw)) throw new ConfigError('config.json must be an object');

  const apiBaseUrl = raw.apiBaseUrl ?? '';
  if (typeof apiBaseUrl !== 'string') throw new ConfigError('apiBaseUrl must be a string');

  const auth = raw.auth;
  if (!isRecord(auth)) throw new ConfigError('auth must be an object');

  switch (auth.mode) {
    case 'local':
      return {
        apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
        auth: { mode: 'local', defaultTenant: typeof auth.defaultTenant === 'string' ? auth.defaultTenant : 'acme' },
      };
    case 'entra': {
      const scopes = auth.scopes;
      if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((s) => typeof s === 'string' && s !== '')) {
        throw new ConfigError('auth.scopes must be a non-empty array of strings');
      }
      return {
        apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
        auth: {
          mode: 'entra',
          clientId: requireString(auth, 'clientId', 'auth.'),
          authority: requireString(auth, 'authority', 'auth.'),
          scopes: scopes as string[],
        },
      };
    }
    default:
      throw new ConfigError('auth.mode must be "local" or "entra"');
  }
}

export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new ConfigError(`GET /config.json failed: ${response.status}`);
  return parseConfig(await response.json());
}
