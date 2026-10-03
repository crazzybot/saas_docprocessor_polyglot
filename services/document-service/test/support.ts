/** Shared setup for the document service tests: settings, app, tokens, files. */

import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { loadSettings } from '@docprocessor/shared';
import { zipSync } from 'fflate';
import { generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { TokenVerifier } from '../src/api/auth.js';
import { DocumentService } from '../src/application/document.service.js';
import { documentServiceSettings, withDerived, type RawSettings, type Settings } from '../src/config.js';
import { FakeStorage, InMemoryDocumentRepository } from './fakes.js';

export const TEST_TENANT_ID = '11111111-1111-1111-1111-111111111111';
export const OTHER_TENANT_ID = '22222222-2222-2222-2222-222222222222';
export const AUDIENCE = 'api://saas-docprocessor';
export const PDF_BYTES = Buffer.from('%PDF-1.7\n%test document\n');

export function testSettings(overrides: Partial<RawSettings> = {}): Settings {
  return withDerived({
    ...loadSettings(documentServiceSettings, {}),
    authEnabled: false,
    azureAdAllowedTenantIds: TEST_TENANT_ID,
    azureAdRequiredScope: 'Documents.Upload',
    ...overrides,
  });
}

export function docxBytes(parts: Record<string, string> = { 'word/document.xml': '<w:document/>' }): Buffer {
  return Buffer.from(
    zipSync(Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, Buffer.from(text)]))),
  );
}

export interface Backend {
  repo: InMemoryDocumentRepository;
  storage: FakeStorage;
  service: DocumentService;
  notify: ReturnType<typeof vi.fn>;
}

export function createBackend(): Backend {
  const repo = new InMemoryDocumentRepository();
  const storage = new FakeStorage();
  const notify = vi.fn();
  const service = new DocumentService(repo, storage, { rawContainer: 'raw-documents', notifyOutbox: notify });
  return { repo, storage, service, notify };
}

export interface TestApp extends Backend {
  app: INestApplication;
  settings: Settings;
}

/** The real AppModule over in-memory fakes, with a test signing key for auth. */
export async function createTestApp(options: { settings?: Settings; verifierKey?: CryptoKey } = {}): Promise<TestApp> {
  const backend = createBackend();
  const settings = options.settings ?? testSettings();
  const verifierKey = options.verifierKey;
  const moduleRef = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        settings,
        repository: backend.repo,
        storage: backend.storage,
        service: backend.service,
        ...(verifierKey ? { tokenVerifier: new TokenVerifier(settings, async () => verifierKey) } : {}),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return { ...backend, app, settings };
}

export async function signingKeys(): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }> {
  return generateKeyPair('RS256');
}

export async function makeToken(
  privateKey: CryptoKey,
  claims: {
    tid?: string;
    iss?: string;
    aud?: string;
    scp?: string | null;
    roles?: string[];
    expOffsetSeconds?: number;
  } = {},
): Promise<string> {
  const tid = claims.tid ?? TEST_TENANT_ID;
  const payload: Record<string, unknown> = {
    sub: 'user-1',
    tid,
    ...(claims.scp === null ? {} : { scp: claims.scp ?? 'Documents.Upload' }),
    ...(claims.roles ? { roles: claims.roles } : {}),
  };
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuer(claims.iss ?? `https://login.microsoftonline.com/${tid}/v2.0`)
    .setAudience(claims.aud ?? AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + (claims.expOffsetSeconds ?? 3600))
    .sign(privateKey);
}
