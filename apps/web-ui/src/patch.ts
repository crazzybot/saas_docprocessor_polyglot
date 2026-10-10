/**
 * The edit form's text fields to a JSON merge patch (`DocumentPatch`) that
 * holds only what changed. Kept free of React so it is unit-tested.
 */

import type { Document, DocumentPatch } from './api';

export interface EditFields {
  title: string;
  /** Comma- or newline-separated. */
  tags: string;
  /** One `key=value` per line. */
  metadata: string;
}

export function fieldsOf(doc: Document): EditFields {
  // contracts/openapi.json types metadata values as `never` (the schema lacks
  // additionalProperties); the API returns strings.
  const metadata = doc.metadata as Record<string, string>;
  return {
    title: doc.title ?? '',
    tags: doc.tags.join(', '),
    metadata: Object.entries(metadata)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  };
}

export function parseTags(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[,\n]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}

/** Throws on a line without `=`; the API validates lengths and counts. */
export function parseMetadata(text: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`Metadata line ${index + 1}: expected key=value`);
    metadata[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return metadata;
}

function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Only the fields that differ from `doc`; an emptied field becomes `null` (clears it). */
export function buildPatch(doc: Document, fields: EditFields): DocumentPatch {
  const patch: DocumentPatch = {};

  const title = fields.title.trim();
  if (title !== (doc.title ?? '')) patch.title = title === '' ? null : title;

  const tags = parseTags(fields.tags);
  if (tags.join('\n') !== doc.tags.join('\n')) patch.tags = tags.length ? tags : null;

  const metadata = parseMetadata(fields.metadata);
  if (!sameRecord(metadata, doc.metadata)) {
    patch.metadata = Object.keys(metadata).length ? metadata : null;
  }

  return patch;
}
