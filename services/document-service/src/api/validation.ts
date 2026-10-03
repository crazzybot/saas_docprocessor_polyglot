/** Upload validation: content type, magic bytes, and filename. */

import { posix } from 'node:path';

import { unzipSync } from 'fflate';

import { DOCX_CONTENT_TYPE } from '../config.js';
import { ApiError } from './api-error.js';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function validateContentType(contentType: string | undefined, allowed: readonly string[]): string {
  if (contentType === undefined || !allowed.includes(contentType)) {
    throw new ApiError(415, `Unsupported content type '${contentType}'. Allowed: ${allowed.join(', ')}`);
  }
  return contentType;
}

function startsWith(data: Buffer, magic: readonly number[]): boolean {
  return data.length >= magic.length && magic.every((byte, i) => data[i] === byte);
}

function isDocx(data: Buffer): boolean {
  if (!startsWith(data, [0x50, 0x4b, 0x03, 0x04])) {
    return false;
  }
  let found = false;
  try {
    // List the entries without inflating any of them.
    unzipSync(data, {
      filter: (file) => {
        found ||= file.name === 'word/document.xml';
        return false;
      },
    });
  } catch {
    return false;
  }
  return found;
}

/**
 * Check the file's magic bytes against its declared content type, so a
 * mislabelled file is rejected at the edge rather than failing in the worker.
 */
export function contentMatchesType(contentType: string, data: Buffer): boolean {
  switch (contentType) {
    case 'application/pdf':
      return startsWith(data, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
    case 'image/png':
      return startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'image/jpeg':
      return startsWith(data, [0xff, 0xd8, 0xff]);
    case DOCX_CONTENT_TYPE:
      return isDocx(data);
    default:
      return false;
  }
}

/** Length in code points (not UTF-16 units), like Python's `len`. */
function codePoints(value: string): string[] {
  return Array.from(value);
}

/**
 * Reduce a client-supplied filename to a safe final path component.
 *
 * Strips directories (both `/` and `\` separators), control characters and
 * surrounding whitespace, and caps the length while keeping the extension.
 */
export function sanitizeFilename(raw: string | undefined, options: { fallback: string; maxLength: number }): string {
  const parts = (raw ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  let name = (parts.at(-1) ?? '').replace(CONTROL_CHARS, '').trim();
  if (name === '' || name === '.' || name === '..') {
    return options.fallback;
  }
  const chars = codePoints(name);
  if (chars.length > options.maxLength) {
    const ext = posix.extname(name);
    const suffix = codePoints(ext === '.' ? '' : ext).slice(0, 16);
    name = [...chars.slice(0, options.maxLength - suffix.length), ...suffix].join('');
  }
  return name;
}
