/**
 * Document routes. Handlers validate input, call `DocumentService`, and shape
 * the response; domain errors are mapped to status codes by
 * `ApiExceptionFilter`.
 */

import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { currentCorrelationId, getLogger, getTracer, injectTraceContext, withSpan } from '@docprocessor/shared';
import type { Response } from 'express';

import { DocumentService } from '../application/document.service.js';
import { SETTINGS, type Settings } from '../config.js';
import { etagOf, PageCursor, type Document } from '../domain/models.js';
import { ApiError, validationError } from './api-error.js';
import { CurrentPrincipal, Tenant, type Principal } from './auth.js';
import {
  DocIdSchema,
  documentPath,
  DocumentPatchSchema,
  listQuerySchema,
  parseRequest,
  toDocumentChanges,
  toDocumentListResponse,
  toDocumentResponse,
  toUploadResponse,
  type DocumentListResponse,
  type DocumentResponse,
  type UploadResponse,
} from './schemas.js';
import { contentMatchesType, sanitizeFilename, validateContentType } from './validation.js';

const logger = getLogger('document_service.api.routes');

/** The fields of multer's in-memory file this controller reads. */
interface UploadedFileData {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}
const tracer = getTracer('document_service.api.routes');

/** `undefined` / `*` mean "any version". Otherwise it must be an ETag this service issued. */
function parseIfMatch(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '*') {
    return null;
  }
  const tag = value.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (!/^\d+$/.test(tag)) {
    throw new ApiError(412, 'If-Match does not match');
  }
  return Number(tag);
}

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
function contentDisposition(filename: string): string {
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '').replace(/["\\]/g, '') || 'document';
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`;
}

function parseDocId(raw: string): string {
  return parseRequest(DocIdSchema, raw, 'path');
}

@Controller()
export class DocumentsController {
  constructor(
    @Inject(DocumentService) private readonly service: DocumentService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  private async upload(
    file: UploadedFileData | undefined,
    principal: Principal,
    tenantId: string,
  ): Promise<{ doc: Document; blobUrl: string }> {
    if (file === undefined) {
      throw validationError([{ loc: ['body', 'file'], msg: 'Field required', type: 'missing' }]);
    }
    const contentType = validateContentType(file.mimetype, this.settings.allowedContentTypes);
    const data = file.buffer;
    if (data.length === 0) {
      throw new ApiError(400, 'Empty file upload');
    }
    if (!contentMatchesType(contentType, data)) {
      throw new ApiError(415, `File content does not match declared content type '${contentType}'`);
    }

    const docId = randomUUID();
    const filename = sanitizeFilename(file.originalname, {
      fallback: docId,
      maxLength: this.settings.maxFilenameLength,
    });
    logger.info('upload_received', {
      doc_id: docId,
      tenant_id: tenantId,
      filename,
      content_type: contentType,
      size_bytes: data.length,
      principal: principal.subject,
    });
    return withSpan(
      tracer,
      'upload_document',
      () =>
        this.service.upload({
          docId,
          tenantId,
          filename,
          contentType,
          data,
          correlationId: currentCorrelationId(),
          // Captured inside this span so the worker's spans join this trace.
          traceContext: injectTraceContext(),
        }),
      { attributes: { doc_id: docId } },
    );
  }

  /** Upload a document; text extraction runs asynchronously. */
  @Post('documents')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file'))
  async createDocument(
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentPrincipal() principal: Principal,
    @Tenant() tenantId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocumentResponse> {
    const { doc } = await this.upload(file, principal, tenantId);
    response.setHeader('Location', documentPath(doc.id));
    response.setHeader('ETag', etagOf(doc));
    return toDocumentResponse(doc);
  }

  /** Deprecated alias of POST /documents. */
  @Post('upload')
  @HttpCode(202)
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: UploadedFileData | undefined,
    @CurrentPrincipal() principal: Principal,
    @Tenant() tenantId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UploadResponse> {
    const { doc, blobUrl } = await this.upload(file, principal, tenantId);
    response.setHeader('Location', documentPath(doc.id));
    response.setHeader('Deprecation', 'true');
    response.setHeader('Link', '</documents>; rel="successor-version"');
    return toUploadResponse(doc, blobUrl);
  }

  // -------------------------------------------------------------------------
  // Catalog
  // -------------------------------------------------------------------------

  @Get('documents')
  async listDocuments(@Tenant() tenantId: string, @Query() query: unknown): Promise<DocumentListResponse> {
    const { limit, cursor, status } = parseRequest(listQuerySchema(this.settings.maxPageSize), query, 'query');
    const page = await this.service.list(tenantId, {
      limit: limit ?? this.settings.defaultPageSize,
      cursor: cursor ? PageCursor.decode(cursor) : null,
      status: status ?? null,
    });
    return toDocumentListResponse(page);
  }

  @Get('documents/:docId')
  async getDocument(
    @Param('docId') rawDocId: string,
    @Tenant() tenantId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocumentResponse> {
    const doc = await this.service.get(tenantId, parseDocId(rawDocId));
    response.setHeader('ETag', etagOf(doc));
    return toDocumentResponse(doc);
  }

  @Patch('documents/:docId')
  async updateDocument(
    @Param('docId') rawDocId: string,
    @Body() body: unknown,
    @Tenant() tenantId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocumentResponse> {
    const docId = parseDocId(rawDocId);
    const patch = parseRequest(DocumentPatchSchema, body, 'body');
    const doc = await this.service.update(tenantId, docId, toDocumentChanges(patch), {
      expectedVersion: parseIfMatch(ifMatch),
      correlationId: currentCorrelationId(),
    });
    response.setHeader('ETag', etagOf(doc));
    return toDocumentResponse(doc);
  }

  @Delete('documents/:docId')
  @HttpCode(204)
  async deleteDocument(
    @Param('docId') rawDocId: string,
    @Tenant() tenantId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.service.delete(tenantId, parseDocId(rawDocId), {
      expectedVersion: parseIfMatch(ifMatch),
      correlationId: currentCorrelationId(),
    });
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  /** Stream the original file through the service (storage stays private). */
  @Get('documents/:docId/content')
  async getDocumentContent(
    @Param('docId') rawDocId: string,
    @Tenant() tenantId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const { doc, content } = await this.service.openContent(tenantId, parseDocId(rawDocId));
    response.setHeader('ETag', etagOf(doc));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(content.stream, {
      type: doc.contentType,
      length: content.size,
      disposition: contentDisposition(doc.filename),
    });
  }

  /** The extracted text; 409 until extraction has succeeded. */
  @Get('documents/:docId/text')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  async getDocumentText(
    @Param('docId') rawDocId: string,
    @Tenant() tenantId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const { doc, text } = await this.service.getText(tenantId, parseDocId(rawDocId));
    response.setHeader('ETag', etagOf(doc));
    return text;
  }
}
