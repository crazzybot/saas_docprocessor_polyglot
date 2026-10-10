/**
 * The document service client, typed from contracts/openapi.json (see
 * src/generated/api.ts), plus a log of every request it makes. Each request
 * gets its own `X-Correlation-ID`, so a row in the log can be looked up in the
 * services' logs and traces.
 */

import createClient, { type Client } from 'openapi-fetch';

import type { components, paths } from './generated/api';

export type Document = components['schemas']['DocumentResponse'];
export type DocumentPatch = components['schemas']['DocumentPatch'];
export type DocumentStatus = Document['status'];
export type Api = Client<paths>;

export interface LoggedRequest {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly correlationId: string;
  readonly startedAt: number;
  /** HTTP status, or null while pending or after a network error. */
  readonly status: number | null;
  readonly durationMs: number | null;
  readonly error: string | null;
}

const MAX_LOGGED = 200;

/** Newest first; replaced (never mutated) on each change, for useSyncExternalStore. */
let logged: readonly LoggedRequest[] = [];
const listeners = new Set<() => void>();

function record(id: string, change: (previous: LoggedRequest | undefined) => LoggedRequest): void {
  const index = logged.findIndex((entry) => entry.id === id);
  const next = change(index === -1 ? undefined : logged[index]);
  logged = index === -1 ? [next, ...logged].slice(0, MAX_LOGGED) : logged.with(index, next);
  for (const listener of listeners) listener();
}

export const requestLog = {
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: (): readonly LoggedRequest[] => logged,
  clear: (): void => {
    logged = [];
    for (const listener of listeners) listener();
  },
};

/**
 * @param headers The auth headers for each request: `Authorization`, or
 *   `X-Tenant-ID` when the API runs with auth disabled.
 */
export function createApi(baseUrl: string, headers: () => Promise<Record<string, string>>): Api {
  const api = createClient<paths>({ baseUrl });
  api.use({
    async onRequest({ request, id }) {
      for (const [name, value] of Object.entries(await headers())) request.headers.set(name, value);
      const correlationId = crypto.randomUUID();
      request.headers.set('X-Correlation-ID', correlationId);
      const url = new URL(request.url);
      record(id, () => ({
        id,
        method: request.method,
        path: url.pathname + url.search,
        correlationId,
        startedAt: performance.now(),
        status: null,
        durationMs: null,
        error: null,
      }));
      return request;
    },
    onResponse({ response, id }) {
      record(id, (entry) => ({
        ...entry!,
        status: response.status,
        durationMs: performance.now() - entry!.startedAt,
        correlationId: response.headers.get('X-Correlation-ID') ?? entry!.correlationId,
      }));
    },
    onError({ error, id }) {
      record(id, (entry) => ({
        ...entry!,
        durationMs: performance.now() - entry!.startedAt,
        error: error instanceof Error ? error.message : String(error),
      }));
    },
  });
  return api;
}

/** A one-line message from an error response (`ErrorResponse` or `ValidationErrorResponse`). */
export function describeError(status: number, body: unknown): string {
  const detail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : undefined;
  if (typeof detail === 'string') return `${status}: ${detail}`;
  if (Array.isArray(detail)) {
    const issues = detail.map((issue: unknown) => {
      if (typeof issue !== 'object' || issue === null) return String(issue);
      const { loc, msg } = issue as { loc?: unknown; msg?: unknown };
      const where = Array.isArray(loc) ? loc.join('.') : '';
      return where ? `${where}: ${String(msg)}` : String(msg);
    });
    return `${status}: ${issues.join('; ')}`;
  }
  if (typeof body === 'string' && body !== '') return `${status}: ${body}`;
  return `${status}: request failed`;
}

/** Thrown by the helpers below so components can show one error string. */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    body: unknown,
  ) {
    super(describeError(status, body));
  }
}

// ---------------------------------------------------------------------------
// One helper per operation: the data on success, ApiFailure otherwise.
// ---------------------------------------------------------------------------

export interface Versioned {
  readonly doc: Document;
  /** Send back in `If-Match` to update only this version. */
  readonly etag: string | null;
}

export async function listDocuments(api: Api, query: { status?: DocumentStatus; cursor?: string; limit?: number }) {
  const { data, error, response } = await api.GET('/documents', { params: { query } });
  if (!data) throw new ApiFailure(response.status, error);
  return data;
}

export async function getDocument(api: Api, docId: string): Promise<Versioned> {
  const { data, error, response } = await api.GET('/documents/{docId}', { params: { path: { docId } } });
  if (!data) throw new ApiFailure(response.status, error);
  return { doc: data, etag: response.headers.get('ETag') };
}

export async function uploadDocument(api: Api, file: File): Promise<Document> {
  const { data, error, response } = await api.POST('/documents', {
    // The typed body only names the field; the serializer sends the file itself.
    body: { file: file.name },
    bodySerializer() {
      const form = new FormData();
      form.append('file', file);
      return form;
    },
  });
  if (!data) throw new ApiFailure(response.status, error);
  return data;
}

export async function updateDocument(
  api: Api,
  docId: string,
  patch: DocumentPatch,
  etag: string | null,
): Promise<Versioned> {
  const { data, error, response } = await api.PATCH('/documents/{docId}', {
    params: { path: { docId }, header: etag ? { 'If-Match': etag } : {} },
    body: patch,
  });
  if (!data) throw new ApiFailure(response.status, error);
  return { doc: data, etag: response.headers.get('ETag') };
}

export async function deleteDocument(api: Api, docId: string): Promise<void> {
  const { error, response } = await api.DELETE('/documents/{docId}', { params: { path: { docId } } });
  if (!response.ok) throw new ApiFailure(response.status, error);
}

export async function getText(api: Api, docId: string): Promise<string> {
  const { data, error, response } = await api.GET('/documents/{docId}/text', {
    params: { path: { docId } },
    parseAs: 'text',
  });
  if (data === undefined) throw new ApiFailure(response.status, error);
  return data;
}

/** The original file; fetched rather than linked, since it needs the auth headers. */
export async function getContent(api: Api, docId: string): Promise<Blob> {
  const { data, error, response } = await api.GET('/documents/{docId}/content', {
    params: { path: { docId } },
    parseAs: 'blob',
  });
  if (data === undefined) throw new ApiFailure(response.status, error);
  return data;
}
