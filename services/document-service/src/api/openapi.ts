/**
 * The HTTP API's OpenAPI 3.1 document, built from the zod schemas in
 * `schemas.ts`. `scripts/generate-openapi.mjs` writes it to
 * `contracts/openapi.json` (run `just contracts`), and `just contracts-check`
 * fails if the committed file is out of date.
 *
 * `OPERATIONS` is the table of routes. The API tests check it both ways: every
 * controller route is listed here, and every response a test receives has
 * its status listed here and matches its schema.
 */

import { z } from 'zod';

import type { Settings } from '../config.js';
import {
  DocIdSchema,
  DocumentLinksSchema,
  DocumentListResponseSchema,
  DocumentPatchSchema,
  DocumentResponseSchema,
  ErrorResponseSchema,
  listQuerySchema,
  ProbeResponseSchema,
  UploadResponseSchema,
  ValidationErrorResponseSchema,
} from './schemas.js';

type Method = 'get' | 'post' | 'patch' | 'delete';
type HeaderName = keyof typeof HEADERS;

export interface DocumentedResponse {
  description: string;
  /** A JSON body. */
  schema?: z.ZodType;
  /** A non-JSON body, as an OpenAPI `content` map. */
  content?: Record<string, unknown>;
  headers?: HeaderName[];
}

export interface Operation {
  method: Method;
  /** OpenAPI path template, e.g. `/documents/{docId}`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: 'documents' | 'probes';
  /** Probes are unauthenticated. */
  public?: boolean;
  deprecated?: boolean;
  /** Takes `If-Match`. */
  conditional?: boolean;
  query?: z.ZodObject;
  requestBody?: { description?: string; content: Record<string, unknown> };
  responses: Record<number, DocumentedResponse>;
}

const HEADERS = {
  ETag: { description: "The document's version; send it back in `If-Match`.", schema: { type: 'string' } },
  Location: { description: "The new document's URL.", schema: { type: 'string' } },
  Deprecation: { description: 'This endpoint is deprecated.', schema: { type: 'string' } },
  Link: { description: 'The successor endpoint.', schema: { type: 'string' } },
  'Retry-After': { description: 'Seconds to wait before retrying.', schema: { type: 'integer' } },
  'WWW-Authenticate': { description: 'The authentication scheme.', schema: { type: 'string' } },
  'X-Correlation-ID': {
    description: "The request's correlation ID: the client's, or a new one.",
    schema: { type: 'string' },
  },
} as const;

const error = (description: string, headers?: HeaderName[]): DocumentedResponse => ({
  description,
  schema: ErrorResponseSchema,
  ...(headers ? { headers } : {}),
});

/** Responses every authenticated route can return. */
const AUTHENTICATED_ERRORS: Record<number, DocumentedResponse> = {
  400: error('Invalid tenant ID.'),
  401: error('Missing, malformed, invalid or expired token.', ['WWW-Authenticate']),
  403: error('Tenant not onboarded, token lacks the required permission, or `X-Tenant-ID` differs from the token.'),
  503: error('A dependency is unavailable; retry later.', ['Retry-After']),
};

const NOT_FOUND = error('No such document for this tenant.');
const INVALID = { description: 'The request failed validation.', schema: ValidationErrorResponseSchema };
const PRECONDITION_FAILED = error('`If-Match` does not match the current version.', ['ETag']);

function uploadOperation(settings: Pick<Settings, 'maxUploadSizeMb' | 'allowedContentTypes'>) {
  return {
    requestBody: {
      description: `One file, at most ${settings.maxUploadSizeMb} MB, of type ${settings.allowedContentTypes.join(', ')}. Its content must match the declared type.`,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: { file: { type: 'string', format: 'binary' } },
            required: ['file'],
          },
        },
      },
    },
    errors: {
      400: error('Empty file, or invalid tenant ID.'),
      413: error('The file is too large.'),
      415: error('Unsupported content type, or the content does not match it.'),
      422: INVALID,
    },
  };
}

export function operations(
  settings: Pick<Settings, 'maxPageSize' | 'defaultPageSize' | 'maxUploadSizeMb' | 'allowedContentTypes'>,
): Operation[] {
  const upload = uploadOperation(settings);
  return [
    {
      method: 'post',
      path: '/documents',
      operationId: 'createDocument',
      summary: 'Upload a document',
      description: 'Stores the file and queues it for text extraction, which runs asynchronously.',
      tag: 'documents',
      requestBody: upload.requestBody,
      responses: {
        202: {
          description: 'Accepted; status is `queued`.',
          schema: DocumentResponseSchema,
          headers: ['Location', 'ETag'],
        },
        ...AUTHENTICATED_ERRORS,
        ...upload.errors,
      },
    },
    {
      method: 'post',
      path: '/upload',
      operationId: 'uploadDocument',
      summary: 'Upload a document (deprecated)',
      description: 'Use `POST /documents`.',
      tag: 'documents',
      deprecated: true,
      requestBody: upload.requestBody,
      responses: {
        202: {
          description: 'Accepted; status is `queued`.',
          schema: UploadResponseSchema,
          headers: ['Location', 'Deprecation', 'Link'],
        },
        ...AUTHENTICATED_ERRORS,
        ...upload.errors,
      },
    },
    {
      method: 'get',
      path: '/documents',
      operationId: 'listDocuments',
      summary: 'List documents',
      description: `Newest first, ${settings.defaultPageSize} per page unless \`limit\` says otherwise.`,
      tag: 'documents',
      query: listQuerySchema(settings.maxPageSize),
      responses: {
        200: { description: 'One page of documents.', schema: DocumentListResponseSchema },
        ...AUTHENTICATED_ERRORS,
        400: error('Invalid cursor, or invalid tenant ID.'),
        422: INVALID,
      },
    },
    {
      method: 'get',
      path: '/documents/{docId}',
      operationId: 'getDocument',
      summary: 'Get a document',
      tag: 'documents',
      responses: {
        200: { description: 'The document.', schema: DocumentResponseSchema, headers: ['ETag'] },
        ...AUTHENTICATED_ERRORS,
        404: NOT_FOUND,
        422: INVALID,
      },
    },
    {
      method: 'patch',
      path: '/documents/{docId}',
      operationId: 'updateDocument',
      summary: "Update a document's title, tags or metadata",
      tag: 'documents',
      conditional: true,
      requestBody: {
        description:
          'JSON merge-patch semantics: only fields present are changed; `null` clears `title` and empties `tags` / `metadata`. Unknown fields are rejected.',
        content: { 'application/json': { schema: ref('DocumentPatch') } },
      },
      responses: {
        200: { description: 'The updated document.', schema: DocumentResponseSchema, headers: ['ETag'] },
        ...AUTHENTICATED_ERRORS,
        404: NOT_FOUND,
        412: PRECONDITION_FAILED,
        422: INVALID,
      },
    },
    {
      method: 'delete',
      path: '/documents/{docId}',
      operationId: 'deleteDocument',
      summary: 'Delete a document',
      tag: 'documents',
      conditional: true,
      responses: {
        204: { description: 'Deleted.' },
        ...AUTHENTICATED_ERRORS,
        404: NOT_FOUND,
        412: PRECONDITION_FAILED,
        422: INVALID,
      },
    },
    {
      method: 'get',
      path: '/documents/{docId}/content',
      operationId: 'getDocumentContent',
      summary: 'Download the original file',
      tag: 'documents',
      responses: {
        200: {
          description: 'The file, with its original content type and filename (`Content-Disposition`).',
          content: Object.fromEntries(
            settings.allowedContentTypes.map((type) => [type, { schema: { type: 'string', format: 'binary' } }]),
          ),
          headers: ['ETag'],
        },
        ...AUTHENTICATED_ERRORS,
        404: NOT_FOUND,
        422: INVALID,
      },
    },
    {
      method: 'get',
      path: '/documents/{docId}/text',
      operationId: 'getDocumentText',
      summary: 'Get the extracted text',
      tag: 'documents',
      responses: {
        200: {
          description: 'The extracted text.',
          content: { 'text/plain': { schema: { type: 'string' } } },
          headers: ['ETag'],
        },
        ...AUTHENTICATED_ERRORS,
        404: NOT_FOUND,
        409: error('Extraction has not succeeded (yet).'),
        422: INVALID,
      },
    },
    {
      method: 'get',
      path: '/healthz',
      operationId: 'health',
      summary: 'Liveness probe',
      tag: 'probes',
      public: true,
      responses: { 200: { description: 'The process is up.', schema: ProbeResponseSchema } },
    },
    {
      method: 'get',
      path: '/readyz',
      operationId: 'ready',
      summary: 'Readiness probe',
      description: 'Checks the catalog database and Blob Storage (not Service Bus).',
      tag: 'probes',
      public: true,
      responses: {
        200: { description: 'Ready to serve requests.', schema: ProbeResponseSchema },
        503: error('A dependency is unreachable.'),
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function ref(name: string): JsonSchema {
  return { $ref: `#/components/schemas/${name}` };
}

/** Named JSON response schemas; any other response schema is inlined. */
const RESPONSE_SCHEMAS: Record<string, z.ZodType> = {
  DocumentResponse: DocumentResponseSchema,
  DocumentListResponse: DocumentListResponseSchema,
  UploadResponse: UploadResponseSchema,
  ErrorResponse: ErrorResponseSchema,
  ValidationErrorResponse: ValidationErrorResponseSchema,
  ProbeResponse: ProbeResponseSchema,
};

function jsonSchemaParams(io: 'input' | 'output') {
  return {
    io,
    uri: (id: string) => `#/components/schemas/${id}`,
    override: ({ jsonSchema }: { jsonSchema: JsonSchema }) => {
      // Responses are strict in zod (for the tests), but clients must ignore
      // fields they don't know, so new fields stay a compatible change.
      if (io === 'output') {
        delete jsonSchema.additionalProperties;
      }
      // zod adds its own regex next to the format.
      if (jsonSchema.format === 'date-time') {
        delete jsonSchema.pattern;
      }
    },
  };
}

/** Components, and how each response schema is referenced. */
function components() {
  const responses = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(RESPONSE_SCHEMAS)) {
    responses.add(schema, { id });
  }
  responses.add(DocumentLinksSchema, { id: 'DocumentLinks' });
  const requests = z.registry<{ id: string }>();
  requests.add(DocumentPatchSchema, { id: 'DocumentPatch' });

  const schemas: Record<string, JsonSchema> = {};
  for (const converted of [
    z.toJSONSchema(responses, jsonSchemaParams('output')),
    z.toJSONSchema(requests, jsonSchemaParams('input')),
  ]) {
    for (const [id, { $schema: _, $id: __, ...schema }] of Object.entries(
      converted.schemas as Record<string, JsonSchema>,
    )) {
      schemas[id] = schema;
    }
  }
  const refs = new Map(Object.entries(RESPONSE_SCHEMAS).map(([id, schema]) => [schema, ref(id)]));
  return { schemas, refs };
}

function inline(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, jsonSchemaParams(io)) as JsonSchema;
  return rest;
}

function parameters(op: Operation): JsonSchema[] {
  const params: JsonSchema[] = [];
  if (op.path.includes('{docId}')) {
    params.push({ name: 'docId', in: 'path', required: true, schema: inline(DocIdSchema, 'input') });
  }
  if (op.query) {
    const { properties = {}, required = [] } = inline(op.query, 'input') as {
      properties?: Record<string, JsonSchema>;
      required?: string[];
    };
    for (const [name, schema] of Object.entries(properties)) {
      const { description, ...rest } = schema;
      params.push({
        name,
        in: 'query',
        required: required.includes(name),
        ...(description ? { description } : {}),
        schema: rest,
      });
    }
  }
  if (op.conditional) {
    params.push({ $ref: '#/components/parameters/IfMatch' });
  }
  if (!op.public) {
    params.push({ $ref: '#/components/parameters/TenantId' });
  }
  params.push({ $ref: '#/components/parameters/CorrelationId' });
  return params;
}

export function buildOpenApiDocument(
  version: string,
  settings: Pick<Settings, 'maxPageSize' | 'defaultPageSize' | 'maxUploadSizeMb' | 'allowedContentTypes'>,
): JsonSchema {
  const { schemas, refs } = components();
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const op of operations(settings)) {
    const responses = Object.fromEntries(
      Object.entries(op.responses).map(([status, response]) => {
        const content = response.schema
          ? { 'application/json': { schema: refs.get(response.schema) ?? inline(response.schema, 'output') } }
          : response.content;
        const headers = Object.fromEntries(
          [...(response.headers ?? []), 'X-Correlation-ID' as const].map((name) => [
            name,
            { $ref: `#/components/headers/${name}` },
          ]),
        );
        return [status, { description: response.description, headers, ...(content ? { content } : {}) }];
      }),
    );
    (paths[op.path] ??= {})[op.method] = {
      operationId: op.operationId,
      summary: op.summary,
      ...(op.description ? { description: op.description } : {}),
      tags: [op.tag],
      ...(op.deprecated ? { deprecated: true } : {}),
      ...(op.public ? { security: [] } : {}),
      parameters: parameters(op),
      ...(op.requestBody ? { requestBody: { required: true, ...op.requestBody } } : {}),
      responses,
    };
  }

  return {
    openapi: '3.1.1',
    info: {
      title: 'Document Service API',
      version,
      description:
        "Upload documents, browse the catalog, and read the extracted text. Every document belongs to the tenant of the caller's token. Limits shown (page and upload sizes) are the defaults; deployments may configure them.",
    },
    tags: [
      { name: 'documents', description: 'Upload, catalog, content and text.' },
      { name: 'probes', description: 'Liveness and readiness (not routed through the ingress).' },
    ],
    servers: [{ url: '/', description: 'Wherever this document is served from.' }],
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: "A Microsoft Entra ID access token; its `tid` claim is the caller's tenant.",
        },
      },
      parameters: {
        TenantId: {
          name: 'X-Tenant-ID',
          in: 'header',
          required: false,
          description: "Optional; if sent, must match the token's tenant.",
          schema: { type: 'string' },
        },
        CorrelationId: {
          name: 'X-Correlation-ID',
          in: 'header',
          required: false,
          description: 'Propagated to logs and events; generated if absent.',
          schema: { type: 'string' },
        },
        IfMatch: {
          name: 'If-Match',
          in: 'header',
          required: false,
          description:
            'An `ETag` from an earlier response; the request fails with 412 if the document has changed since.',
          schema: { type: 'string' },
        },
      },
      headers: HEADERS,
      schemas,
    },
  };
}
