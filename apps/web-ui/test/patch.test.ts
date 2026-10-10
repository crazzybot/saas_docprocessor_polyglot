import { describe, expect, it } from 'vitest';

import type { Document } from '../src/api';
import { buildPatch, fieldsOf, parseMetadata, parseTags } from '../src/patch';

/** The generated type says `never` for metadata values (see src/patch.ts). */
const meta = (record: Record<string, string>) => record as unknown as Document['metadata'];

function doc(overrides: Partial<Document> = {}): Document {
  return {
    doc_id: '3f0e4c1a-7f0b-4a51-9a0e-2d9b5c6f7a80',
    tenant_id: 'acme',
    filename: 'a.pdf',
    content_type: 'application/pdf',
    size_bytes: 10,
    status: 'succeeded',
    error: null,
    title: null,
    tags: [],
    metadata: {},
    created_at: '2026-10-09T10:00:00Z',
    updated_at: '2026-10-09T10:00:00Z',
    extracted_at: null,
    links: { self: '/documents/x', content: '/documents/x/content', text: null },
    ...overrides,
  };
}

describe('edit form parsing', () => {
  it('splits tags on commas and newlines, trimming and de-duplicating', () => {
    expect(parseTags(' a, b\nc,, a ')).toEqual(['a', 'b', 'c']);
  });

  it('parses key=value lines, keeping "=" in values', () => {
    expect(parseMetadata('k = v\n\nurl=https://x?a=1')).toEqual({ k: 'v', url: 'https://x?a=1' });
  });

  it('rejects a metadata line without a key', () => {
    expect(() => parseMetadata('ok=1\n=v')).toThrow('line 2');
  });
});

describe('buildPatch', () => {
  it('is empty when nothing changed', () => {
    const d = doc({ title: 'T', tags: ['x'], metadata: meta({ k: 'v' }) });
    expect(buildPatch(d, fieldsOf(d))).toEqual({});
  });

  it('holds only the changed fields', () => {
    const d = doc({ tags: ['x'] });
    expect(buildPatch(d, { ...fieldsOf(d), title: ' New ', metadata: 'k=v' })).toEqual({
      title: 'New',
      metadata: { k: 'v' },
    });
  });

  it('sends null to clear a field', () => {
    const d = doc({ title: 'T', tags: ['x'], metadata: meta({ k: 'v' }) });
    expect(buildPatch(d, { title: '', tags: '', metadata: '' })).toEqual({ title: null, tags: null, metadata: null });
  });
});
