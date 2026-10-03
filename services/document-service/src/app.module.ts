/**
 * The Nest module for the HTTP API. It receives already-built dependencies
 * (see `infrastructure.ts`), so tests can mount the same module over
 * in-memory fakes.
 */

import { Module, RequestMethod, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MulterModule } from '@nestjs/platform-express';

import { AuthGuard, TokenVerifier } from './api/auth.js';
import { DocumentsController } from './api/documents.controller.js';
import { ApiExceptionFilter } from './api/error.filter.js';
import { ProbesController } from './api/probes.controller.js';
import { RequestContextMiddleware } from './api/request-context.middleware.js';
import { DocumentService } from './application/document.service.js';
import {
  DOCUMENT_REPOSITORY,
  DOCUMENT_STORAGE,
  type DocumentRepository,
  type DocumentStorage,
} from './application/ports.js';
import { SETTINGS, type Settings } from './config.js';

export interface AppDependencies {
  readonly settings: Settings;
  readonly repository: DocumentRepository;
  readonly storage: DocumentStorage;
  readonly service: DocumentService;
  /** Defaults to Entra ID verification against the configured JWKS. */
  readonly tokenVerifier?: TokenVerifier;
  /**
   * Objects whose Nest lifecycle hooks start and stop background work and
   * close clients (the `Infrastructure` in production).
   */
  readonly lifecycle?: object;
}

const LIFECYCLE = Symbol('Lifecycle');

@Module({})
export class AppModule implements NestModule {
  static forRoot(deps: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      imports: [
        // Uploads are buffered in memory; multer aborts at the size limit
        // (413) without reading the rest of the body.
        MulterModule.register({
          limits: { fileSize: deps.settings.maxUploadSizeBytes, files: 1 },
          // Filenames are UTF-8 (busboy would otherwise read them as latin1).
          defParamCharset: 'utf8',
        }),
      ],
      controllers: [DocumentsController, ProbesController],
      providers: [
        { provide: SETTINGS, useValue: deps.settings },
        { provide: DOCUMENT_REPOSITORY, useValue: deps.repository },
        { provide: DOCUMENT_STORAGE, useValue: deps.storage },
        { provide: DocumentService, useValue: deps.service },
        { provide: TokenVerifier, useValue: deps.tokenVerifier ?? new TokenVerifier(deps.settings) },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
        ...(deps.lifecycle ? [{ provide: LIFECYCLE, useValue: deps.lifecycle }] : []),
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
