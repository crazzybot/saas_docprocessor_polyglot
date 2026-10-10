import { useState } from 'react';

import type { Document, DocumentPatch } from '../api';
import { buildPatch, fieldsOf, type EditFields } from '../patch';

interface Props {
  doc: Document;
  onSave: (patch: DocumentPatch) => Promise<void>;
  disabled: boolean;
}

/** PATCH /documents/{id} with If-Match: title, tags and metadata. */
export function EditForm({ doc, onSave, disabled }: Props) {
  const [fields, setFields] = useState<EditFields>(() => fieldsOf(doc));
  const [problem, setProblem] = useState<string | null>(null);
  // Re-seed the form whenever the server's version changes.
  const [seededFrom, setSeededFrom] = useState(doc.updated_at);
  if (seededFrom !== doc.updated_at) {
    setSeededFrom(doc.updated_at);
    setFields(fieldsOf(doc));
  }

  const set = (key: keyof EditFields) => (event: { target: { value: string } }) =>
    setFields((current) => ({ ...current, [key]: event.target.value }));

  let patch: DocumentPatch | null = null;
  let invalid: string | null = null;
  try {
    patch = buildPatch(doc, fields);
  } catch (e) {
    invalid = e instanceof Error ? e.message : String(e);
  }
  const unchanged = patch !== null && Object.keys(patch).length === 0;

  return (
    <form
      className="edit"
      onSubmit={(event) => {
        event.preventDefault();
        if (!patch) return;
        setProblem(null);
        onSave(patch).catch((e: unknown) => setProblem(e instanceof Error ? e.message : String(e)));
      }}
    >
      <label>
        Title
        <input value={fields.title} onChange={set('title')} placeholder={doc.filename} maxLength={255} />
      </label>
      <label>
        Tags <span className="muted">(comma-separated)</span>
        <input value={fields.tags} onChange={set('tags')} placeholder="invoice, 2026" />
      </label>
      <label>
        Metadata <span className="muted">(one key=value per line)</span>
        <textarea value={fields.metadata} onChange={set('metadata')} rows={3} placeholder="customer=acme" />
      </label>
      {(invalid ?? problem) && <p className="error">{invalid ?? problem}</p>}
      <div className="actions">
        <button className="primary" type="submit" disabled={disabled || !patch || unchanged}>
          Save changes
        </button>
        {patch && !unchanged && <code className="muted patch-preview">PATCH {JSON.stringify(patch)}</code>}
      </div>
    </form>
  );
}
