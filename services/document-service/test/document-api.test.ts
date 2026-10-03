import { DocumentUploadedEvents } from '@docprocessor/shared';
import request from 'supertest';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CryptoKey } from 'jose';

import { contentMatchesType, sanitizeFilename } from '../src/api/validation.js';
import { DOCX_CONTENT_TYPE } from '../src/config.js';
import { RepositoryUnavailableError } from '../src/domain/errors.js';
import { DocumentStatus, EventType } from '../src/domain/models.js';
import {
  createTestApp,
  docxBytes,
  makeToken,
  OTHER_TENANT_ID,
  PDF_BYTES,
  signingKeys,
  TEST_TENANT_ID,
  testSettings,
  type TestApp,
} from './support.js';

const TENANT = { 'X-Tenant-ID': 'acme' };

let t: TestApp;

afterEach(async () => {
  await t?.app.close();
});

function server() {
  return t.app.getHttpServer();
}

function upload(
  body: Buffer = PDF_BYTES,
  options: { filename?: string; contentType?: string; path?: string; headers?: Record<string, string> } = {},
) {
  return request(server())
    .post(options.path ?? '/documents')
    .set(options.headers ?? TENANT)
    .attach('file', body, {
      filename: options.filename ?? 'invoice.pdf',
      contentType: options.contentType ?? 'application/pdf',
    });
}

async function uploadId(headers: Record<string, string> = TENANT): Promise<string> {
  const response = await upload(PDF_BYTES, { headers }).expect(202);
  return response.body.doc_id as string;
}

async function completeExtraction(docId: string, tenantId = 'acme', text = 'hello world'): Promise<void> {
  const textBlob = { container: 'extraction-results', name: `${tenantId}/${docId}.json` };
  t.storage.put(textBlob, JSON.stringify({ extracted_text: text }));
  await t.service.applyExtractionResult({
    tenantId,
    docId,
    status: DocumentStatus.SUCCEEDED,
    textBlob,
    error: null,
    completedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
describe('upload', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  it('records the document and its uploaded event', async () => {
    const response = await upload()
      .set('X-Correlation-ID', 'corr-1')
      .set('traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01')
      .expect(202);

    const docId = response.body.doc_id as string;
    expect(response.body).toMatchObject({ status: 'queued', tenant_id: 'acme', filename: 'invoice.pdf' });
    expect(response.headers.location).toBe(`/documents/${docId}`);
    expect(response.headers.etag).toBe('"1"');
    expect(response.headers['x-correlation-id']).toBe('corr-1');
    expect(response.body.links).toEqual({
      self: `/documents/${docId}`,
      content: `/documents/${docId}/content`,
      text: null,
    });

    const [event] = t.repo.events;
    expect(event?.eventType).toBe(EventType.UPLOADED);
    expect(event?.messageId).toBe(docId);
    const job = DocumentUploadedEvents.parse(event?.body);
    expect(job).toMatchObject({
      doc_id: docId,
      tenant_id: 'acme',
      blob_name: `acme/${docId}/invoice.pdf`,
      blob_container: 'raw-documents',
      size_bytes: PDF_BYTES.length,
      // The correlation ID survives the multipart parser into the event.
      correlation_id: 'corr-1',
    });
    expect(event?.properties).toMatchObject({ event_type: 'document.uploaded', tenant_id: 'acme', doc_id: docId });
    expect(t.notify).toHaveBeenCalledOnce();
  });

  it('makes the document readable immediately', async () => {
    const docId = await uploadId();
    const response = await request(server()).get(`/documents/${docId}`).set(TENANT).expect(200);
    expect(response.body.status).toBe('queued');
    expect(response.headers.etag).toBe('"1"');
  });

  it('keeps the deprecated /upload endpoint working', async () => {
    const response = await upload(PDF_BYTES, { path: '/upload' }).expect(202);
    const docId = response.body.doc_id as string;
    expect(response.body).toMatchObject({
      status: 'queued',
      blob_url: `https://acct.blob.core.windows.net/raw-documents/acme/${docId}/invoice.pdf`,
      links: { self: `/documents/${docId}` },
    });
    expect(response.headers.deprecation).toBe('true');
    expect(response.headers.location).toBe(`/documents/${docId}`);
  });

  it('records blob metadata, keeping UTF-8 filenames intact', async () => {
    const response = await upload(PDF_BYTES, { filename: 'Счёт №1.pdf' }).expect(202);
    const docId = response.body.doc_id as string;
    expect(response.body.filename).toBe('Счёт №1.pdf');
    expect(t.storage.metadata.get(`raw-documents/acme/${docId}/Счёт №1.pdf`)).toEqual({
      doc_id: docId,
      tenant_id: 'acme',
      original_filename: 'Счёт №1.pdf',
    });
  });

  it('removes the blob and returns 503 when the catalog write fails', async () => {
    t.repo.failWith = new RepositoryUnavailableError('down');
    const response = await upload().expect(503);
    expect(response.body).toEqual({ detail: 'Service temporarily unavailable; please retry' });
    expect(response.headers['retry-after']).toBe('5');
    expect(t.storage.blobs.size).toBe(0);
  });

  it('rejects content that does not match the declared type', async () => {
    await upload(Buffer.from('not a pdf'), { contentType: 'application/pdf' }).expect(415);
    await upload(PDF_BYTES, { contentType: 'text/plain', filename: 'a.txt' }).expect(415);
    expect(t.repo.docs.size).toBe(0);
  });

  it('rejects empty, missing and oversized files', async () => {
    await upload(Buffer.alloc(0)).expect(400);
    const missing = await request(server()).post('/documents').set(TENANT).field('other', 'x').expect(422);
    expect(missing.body.detail[0].loc).toEqual(['body', 'file']);
  });

  it('returns 413 above MAX_UPLOAD_SIZE_MB', async () => {
    await t.app.close();
    t = await createTestApp({ settings: testSettings({ maxUploadSizeMb: 1 }) });
    const big = Buffer.concat([PDF_BYTES, Buffer.alloc(1024 * 1024)]);
    const response = await upload(big).expect(413);
    expect(response.body).toEqual({ detail: 'File exceeds maximum size of 1MB' });
  });
});

describe('upload validation helpers', () => {
  it('requires the word/document.xml part for DOCX', () => {
    expect(contentMatchesType(DOCX_CONTENT_TYPE, docxBytes())).toBe(true);
    expect(contentMatchesType(DOCX_CONTENT_TYPE, docxBytes({ 'xl/workbook.xml': '<x/>' }))).toBe(false);
    expect(contentMatchesType(DOCX_CONTENT_TYPE, Buffer.from('PK\x03\x04garbage'))).toBe(false);
  });

  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\scan.png', 'scan.png'],
    ['bad\x00name\x1f.pdf', 'badname.pdf'],
    ['  spaced.pdf  ', 'spaced.pdf'],
    ['..', 'fallback'],
    ['', 'fallback'],
    [undefined, 'fallback'],
  ])('sanitizes %j to %j', (raw, expected) => {
    expect(sanitizeFilename(raw, { fallback: 'fallback', maxLength: 255 })).toBe(expected);
  });

  it('caps the filename length and keeps the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(300)}.pdf`, { fallback: 'x', maxLength: 255 });
    expect(name).toHaveLength(255);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Authentication and tenant isolation
// ---------------------------------------------------------------------------
describe('auth', () => {
  let keys: { publicKey: CryptoKey; privateKey: CryptoKey };

  beforeAll(async () => {
    keys = await signingKeys();
  });

  beforeEach(async () => {
    t = await createTestApp({ settings: testSettings({ authEnabled: true }), verifierKey: keys.publicKey });
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('rejects a missing token', async () => {
    const response = await request(server()).get('/documents').expect(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
  });

  it('takes the tenant from the token', async () => {
    const token = await makeToken(keys.privateKey);
    const response = await upload(PDF_BYTES, { headers: bearer(token) }).expect(202);
    expect(response.body.tenant_id).toBe(TEST_TENANT_ID);
  });

  it('forbids a mismatched X-Tenant-ID and accepts a matching one', async () => {
    const token = await makeToken(keys.privateKey);
    await request(server())
      .get('/documents')
      .set({ ...bearer(token), 'X-Tenant-ID': OTHER_TENANT_ID })
      .expect(403);
    await request(server())
      .get('/documents')
      .set({ ...bearer(token), 'X-Tenant-ID': TEST_TENANT_ID.toUpperCase() })
      .expect(200);
  });

  it('forbids tenants that are not on the allow-list', async () => {
    const token = await makeToken(keys.privateKey, { tid: OTHER_TENANT_ID });
    const response = await request(server()).get('/documents').set(bearer(token)).expect(403);
    expect(response.body.detail).toBe('Tenant is not onboarded');
  });

  it('rejects an issuer that does not match the token tenant', async () => {
    const token = await makeToken(keys.privateKey, {
      iss: `https://login.microsoftonline.com/${OTHER_TENANT_ID}/v2.0`,
    });
    await request(server()).get('/documents').set(bearer(token)).expect(401);
  });

  it('accepts the v1 issuer format', async () => {
    const token = await makeToken(keys.privateKey, { iss: `https://sts.windows.net/${TEST_TENANT_ID}/` });
    await request(server()).get('/documents').set(bearer(token)).expect(200);
  });

  it('rejects the wrong audience, expired tokens and foreign signatures', async () => {
    const otherKeys = await signingKeys();
    for (const token of [
      await makeToken(keys.privateKey, { aud: 'api://other' }),
      await makeToken(keys.privateKey, { expOffsetSeconds: -60 }),
      await makeToken(otherKeys.privateKey),
    ]) {
      await request(server()).get('/documents').set(bearer(token)).expect(401);
    }
  });

  it('requires the scope, or the same app role', async () => {
    await request(server())
      .get('/documents')
      .set(bearer(await makeToken(keys.privateKey, { scp: 'Other.Scope' })))
      .expect(403);
    await request(server())
      .get('/documents')
      .set(bearer(await makeToken(keys.privateKey, { scp: null, roles: ['Documents.Upload'] })))
      .expect(200);
  });

  it('keeps probes public', async () => {
    await request(server()).get('/healthz').expect(200, { status: 'ok' });
  });
});

describe('tenant isolation', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  it("returns 404 for another tenant's document", async () => {
    const docId = await uploadId({ 'X-Tenant-ID': 'acme' });
    const other = { 'X-Tenant-ID': 'globex' };
    await request(server()).get(`/documents/${docId}`).set(other).expect(404);
    await request(server()).get(`/documents/${docId}/content`).set(other).expect(404);
    await request(server()).delete(`/documents/${docId}`).set(other).expect(404);
    const list = await request(server()).get('/documents').set(other).expect(200);
    expect(list.body.items).toEqual([]);
  });

  it('rejects malformed tenant IDs', async () => {
    await request(server()).get('/documents').set('X-Tenant-ID', 'bad/tenant').expect(400);
  });
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
describe('catalog', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  it('pages newest first without gaps or repeats', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await uploadId());
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response: request.Response = await request(server())
        .get('/documents')
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .set(TENANT)
        .expect(200);
      seen.push(...(response.body.items as Array<{ doc_id: string }>).map((item) => item.doc_id));
      cursor = response.body.next_cursor as string | null;
    } while (cursor);
    const expected = [...t.repo.docs.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (b.id > a.id ? 1 : -1))
      .map((d) => d.id);
    expect(seen).toEqual(expected);
    expect(new Set(seen)).toEqual(new Set(ids));
  });

  it('filters by status', async () => {
    const done = await uploadId();
    await uploadId();
    await completeExtraction(done);
    const response = await request(server()).get('/documents?status=succeeded').set(TENANT).expect(200);
    expect(response.body.items.map((item: { doc_id: string }) => item.doc_id)).toEqual([done]);
    expect(response.body.items[0].links.text).toBe(`/documents/${done}/text`);
  });

  it('rejects a bad cursor, limit or status', async () => {
    await request(server()).get('/documents?cursor=not-a-cursor').set(TENANT).expect(400, { detail: 'Invalid cursor' });
    await request(server()).get('/documents?limit=0').set(TENANT).expect(422);
    await request(server()).get('/documents?limit=101').set(TENANT).expect(422);
    await request(server()).get('/documents?status=bogus').set(TENANT).expect(422);
  });

  it('patches metadata and publishes document.updated', async () => {
    const docId = await uploadId();
    const response = await request(server())
      .patch(`/documents/${docId}`)
      .set({ ...TENANT, 'If-Match': '"1"' })
      .send({ title: 'Q3 invoice', tags: ['finance', 'finance', 'q3'], metadata: { vendor: 'ACME' } })
      .expect(200);
    expect(response.body).toMatchObject({ title: 'Q3 invoice', tags: ['finance', 'q3'], metadata: { vendor: 'ACME' } });
    expect(response.headers.etag).toBe('"2"');
    const event = t.repo.events.at(-1);
    expect(event?.eventType).toBe(EventType.UPDATED);
    expect(event?.messageId).toBe(`${docId}:updated:2`);
    expect(event?.body).toMatchObject({ version: 2, title: 'Q3 invoice', tags: ['finance', 'q3'] });
  });

  it('rejects a stale ETag with 412 and the current ETag', async () => {
    const docId = await uploadId();
    await request(server()).patch(`/documents/${docId}`).set(TENANT).send({ title: 'v2' }).expect(200);
    const response = await request(server())
      .patch(`/documents/${docId}`)
      .set({ ...TENANT, 'If-Match': '"1"' })
      .send({ title: 'v3' })
      .expect(412);
    expect(response.headers.etag).toBe('"2"');
    await request(server())
      .patch(`/documents/${docId}`)
      .set({ ...TENANT, 'If-Match': 'garbage' })
      .send({ title: 'v3' })
      .expect(412);
  });

  it('clears fields with null and rejects unknown fields', async () => {
    const docId = await uploadId();
    await request(server())
      .patch(`/documents/${docId}`)
      .set(TENANT)
      .send({ title: 'x', tags: ['a'] })
      .expect(200);
    const cleared = await request(server())
      .patch(`/documents/${docId}`)
      .set(TENANT)
      .send({ title: null, tags: null })
      .expect(200);
    expect(cleared.body).toMatchObject({ title: null, tags: [] });
    const rejected = await request(server())
      .patch(`/documents/${docId}`)
      .set(TENANT)
      .send({ status: 'succeeded' })
      .expect(422);
    expect(rejected.body.detail[0].loc).toEqual(['body']);
  });

  it('tombstones on delete, removes blobs and publishes document.deleted', async () => {
    const docId = await uploadId();
    const rawBlob = { container: 'raw-documents', name: `acme/${docId}/invoice.pdf` };
    expect(t.storage.has(rawBlob)).toBe(true);
    await request(server()).delete(`/documents/${docId}`).set(TENANT).expect(204);
    await request(server()).get(`/documents/${docId}`).set(TENANT).expect(404);
    expect(t.storage.has(rawBlob)).toBe(false);
    expect(t.repo.blobsDeleted.get(docId)).toBe(true);
    expect(t.repo.events.at(-1)?.messageId).toBe(`${docId}:deleted`);
  });

  it('succeeds on delete even if blob removal fails', async () => {
    const docId = await uploadId();
    t.storage.failDeletes = true;
    await request(server()).delete(`/documents/${docId}`).set(TENANT).expect(204);
    expect(t.repo.blobsDeleted.get(docId)).toBe(false); // maintenance retries
  });
});

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------
describe('content', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  it('streams the original file', async () => {
    const docId = (await upload(PDF_BYTES, { filename: 'résumé "final".pdf' }).expect(202)).body.doc_id as string;
    const response = await request(server())
      .get(`/documents/${docId}/content`)
      .set(TENANT)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(Buffer.compare(response.body as Buffer, PDF_BYTES)).toBe(0);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-length']).toBe(String(PDF_BYTES.length));
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="rsum final.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves text with 409 until extraction succeeds', async () => {
    const docId = await uploadId();
    await request(server()).get(`/documents/${docId}/text`).set(TENANT).expect(409);
    await completeExtraction(docId, 'acme', 'Привет');
    const response = await request(server()).get(`/documents/${docId}/text`).set(TENANT).expect(200);
    expect(response.text).toBe('Привет');
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
  });

  it('returns 404 when the blob is missing', async () => {
    const docId = await uploadId();
    t.storage.blobs.clear();
    await request(server())
      .get(`/documents/${docId}/content`)
      .set(TENANT)
      .expect(404, { detail: 'Document content not found' });
  });

  it('rejects an invalid document ID', async () => {
    await request(server()).get('/documents/not-a-uuid').set(TENANT).expect(422);
  });
});

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------
describe('probes', () => {
  beforeEach(async () => {
    t = await createTestApp();
  });

  it('reports ready, then a database outage', async () => {
    await request(server()).get('/readyz').expect(200, { status: 'ready' });
    t.repo.failWith = new RepositoryUnavailableError('down');
    await request(server()).get('/readyz').expect(503, { detail: 'database unavailable' });
  });

  it('returns JSON 404 for unknown routes', async () => {
    const response = await request(server()).get('/nope').set(TENANT).expect(404);
    expect(response.body).toHaveProperty('detail');
  });
});
