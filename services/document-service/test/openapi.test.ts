/**
 * Keeps the OpenAPI document (`src/api/openapi.ts`, published as
 * contracts/openapi.json) honest: it lists every controller route, and real
 * responses have a documented status and match its schema exactly (response
 * schemas are strict, so an undocumented field fails).
 */

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import request, { type Response } from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DocumentsController } from '../src/api/documents.controller.js';
import { operations, type Operation } from '../src/api/openapi.js';
import { ProbesController } from '../src/api/probes.controller.js';
import { DocumentStatus } from '../src/domain/models.js';
import { createTestApp, makeToken, PDF_BYTES, signingKeys, testSettings, type TestApp } from './support.js';

const TENANT = { 'X-Tenant-ID': 'acme' };
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

const OPERATIONS = operations(testSettings());

/** `METHOD /path/{param}` for every route the controllers declare. */
function controllerRoutes(): string[] {
  return [DocumentsController, ProbesController].flatMap((controller) =>
    Object.getOwnPropertyNames(controller.prototype).flatMap((name) => {
      const handler = (controller.prototype as unknown as Record<string, unknown>)[name];
      const path = Reflect.getMetadata(PATH_METADATA, handler as object) as string | undefined;
      if (typeof handler !== 'function' || name === 'constructor' || path === undefined) {
        return [];
      }
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      return [`${method} /${path.replace(/:(\w+)/g, '{$1}')}`];
    }),
  );
}

function operation(operationId: string): Operation {
  const op = OPERATIONS.find((candidate) => candidate.operationId === operationId);
  if (op === undefined) {
    throw new Error(`no operation ${operationId}`);
  }
  return op;
}

/** Fail unless `response` has `status` and `operationId` documents it, body and headers included. */
function expectDocumented(operationId: string, status: number, response: Response): void {
  expect(response.status, `${operationId}: ${JSON.stringify(response.body)}`).toBe(status);
  const documented = operation(operationId).responses[response.status];
  expect(documented, `${operationId} does not document ${response.status}`).toBeDefined();
  if (documented?.schema) {
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    const result = documented.schema.safeParse(response.body);
    expect(result.error?.issues, `${operationId} ${response.status} body`).toBeUndefined();
  } else if (documented?.content) {
    const type = (response.headers['content-type'] as string).split(';')[0] as string;
    expect(Object.keys(documented.content)).toContain(type);
  }
  for (const header of [...(documented?.headers ?? []), 'X-Correlation-ID']) {
    expect(response.headers[header.toLowerCase()], `${operationId} ${response.status} ${header}`).toBeDefined();
  }
}

let t: TestApp;

afterEach(async () => {
  await t?.app.close();
});

describe('OpenAPI document', () => {
  it('lists every controller route, and nothing else', () => {
    const documented = OPERATIONS.map((op) => `${op.method.toUpperCase()} ${op.path}`);
    expect(documented.sort()).toEqual(controllerRoutes().sort());
  });

  it('has unique operation IDs', () => {
    const ids = OPERATIONS.map((op) => op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('responses match the OpenAPI document', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  function api() {
    return request(t.app.getHttpServer());
  }

  async function upload(path = '/documents', body = PDF_BYTES, contentType = 'application/pdf') {
    return api().post(path).set(TENANT).attach('file', body, { filename: 'invoice.pdf', contentType });
  }

  it('documents the document lifecycle', async () => {
    const created = await upload();
    expectDocumented('createDocument', 202, created);
    const docId = created.body.doc_id as string;

    expectDocumented('uploadDocument', 202, await upload('/upload'));
    expectDocumented('listDocuments', 200, await api().get('/documents?limit=1').set(TENANT));
    expectDocumented('getDocument', 200, await api().get(`/documents/${docId}`).set(TENANT));
    expectDocumented(
      'updateDocument',
      200,
      await api()
        .patch(`/documents/${docId}`)
        .set(TENANT)
        .send({ title: 'Invoice', tags: ['a'], metadata: { k: 'v' } }),
    );
    expectDocumented('getDocumentContent', 200, await api().get(`/documents/${docId}/content`).set(TENANT));
    expectDocumented('getDocumentText', 409, await api().get(`/documents/${docId}/text`).set(TENANT));

    const textBlob = { container: 'extraction-results', name: `acme/${docId}.json` };
    t.storage.put(textBlob, JSON.stringify({ extracted_text: 'hello' }));
    await t.service.applyExtractionResult({
      tenantId: 'acme',
      docId,
      status: DocumentStatus.SUCCEEDED,
      textBlob,
      error: null,
      completedAt: new Date(),
    });
    const extracted = await api().get(`/documents/${docId}`).set(TENANT);
    expectDocumented('getDocument', 200, extracted);
    expectDocumented('getDocumentText', 200, await api().get(`/documents/${docId}/text`).set(TENANT));

    expectDocumented(
      'deleteDocument',
      204,
      await api()
        .delete(`/documents/${docId}`)
        .set(TENANT)
        .set('If-Match', extracted.headers.etag as string),
    );
    expectDocumented('deleteDocument', 404, await api().delete(`/documents/${docId}`).set(TENANT));
  });

  it('documents the errors', async () => {
    expectDocumented('createDocument', 400, await upload('/documents', Buffer.alloc(0)));
    expectDocumented('createDocument', 415, await upload('/documents', PDF_BYTES, 'text/plain'));
    expectDocumented('createDocument', 422, await api().post('/documents').set(TENANT).field('other', 'x'));
    expectDocumented('listDocuments', 400, await api().get('/documents?cursor=bogus').set(TENANT));
    expectDocumented('listDocuments', 422, await api().get('/documents?limit=0').set(TENANT));
    expectDocumented('getDocument', 404, await api().get(`/documents/${MISSING_ID}`).set(TENANT));
    expectDocumented('getDocument', 422, await api().get('/documents/not-a-uuid').set(TENANT));
    expectDocumented('getDocument', 400, await api().get(`/documents/${MISSING_ID}`).set('X-Tenant-ID', 'bad tenant!'));

    const docId = (await upload()).body.doc_id as string;
    expectDocumented('getDocumentText', 409, await api().get(`/documents/${docId}/text`).set(TENANT));
    expectDocumented('updateDocument', 422, await api().patch(`/documents/${docId}`).set(TENANT).send({ unknown: 1 }));
    expectDocumented(
      'updateDocument',
      412,
      await api().patch(`/documents/${docId}`).set(TENANT).set('If-Match', '"7"').send({ title: 'x' }),
    );
  });

  it('documents the probes', async () => {
    expectDocumented('health', 200, await api().get('/healthz'));
    expectDocumented('ready', 200, await api().get('/readyz'));
  });
});

describe('authentication errors match the OpenAPI document', () => {
  it('documents 401 and 403', async () => {
    const keys = await signingKeys();
    t = await createTestApp({ settings: testSettings({ authEnabled: true }), verifierKey: keys.publicKey });
    const api = () => request(t.app.getHttpServer());
    expectDocumented('listDocuments', 401, await api().get('/documents'));
    const token = await makeToken(keys.privateKey, { scp: 'Other.Scope' });
    expectDocumented('listDocuments', 403, await api().get('/documents').set('Authorization', `Bearer ${token}`));
  });
});
