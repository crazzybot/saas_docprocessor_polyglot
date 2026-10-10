import { useCallback, useEffect, useRef, useState } from 'react';

import {
  ApiFailure,
  deleteDocument,
  getContent,
  getDocument,
  getText,
  updateDocument,
  type Api,
  type DocumentPatch,
  type Versioned,
} from '../api';
import { formatBytes, formatElapsed, formatTime } from '../format';
import { EditForm } from './EditForm';
import { StatusPill } from './StatusPill';

/** How often a queued document is re-read until the worker's result lands. */
const POLL_MS = 1500;

interface Props {
  api: Api;
  docId: string;
  onChanged: () => void;
  onDeleted: () => void;
}

export function DocumentDetail({ api, docId, onChanged, onDeleted }: Props) {
  const [current, setCurrent] = useState<Versioned | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState<{ value: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(
    () =>
      getDocument(api, docId).then(
        (loaded) => {
          setCurrent(loaded);
          setError(null);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [api, docId],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  const status = current?.doc.status;

  // Follow the pipeline: re-read while extraction is pending.
  useEffect(() => {
    if (status !== 'queued') return;
    const timer = window.setInterval(() => void reload(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, reload]);

  // Tell the list when extraction finishes, so its row updates too.
  const wasQueued = useRef(false);
  useEffect(() => {
    if (status === 'queued') {
      wasQueued.current = true;
    } else if (status && wasQueued.current) {
      wasQueued.current = false;
      onChanged();
    }
  }, [status, onChanged]);

  useEffect(() => {
    if (status !== 'succeeded') return;
    let cancelled = false;
    getText(api, docId).then(
      (value) => !cancelled && setText({ value }),
      (e: unknown) => !cancelled && setText({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, docId, status]);

  const withBusy = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const openContent = (download: boolean) =>
    withBusy(async () => {
      const blob = await getContent(api, docId);
      const url = URL.createObjectURL(blob);
      if (download) {
        const link = document.createElement('a');
        link.href = url;
        link.download = current?.doc.filename ?? docId;
        link.click();
      } else {
        window.open(url, '_blank', 'noopener');
      }
      // Long enough for the new tab or the download to pick it up.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    });

  // Errors propagate to the form, which shows them next to the fields.
  const save = async (patch: DocumentPatch) => {
    setBusy(true);
    try {
      setCurrent(await updateDocument(api, docId, patch, current?.etag ?? null));
      onChanged();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 412) {
        await reload();
        throw new Error('412: the document changed since it was loaded. It has been reloaded; apply the edit again.', {
          cause: e,
        });
      }
      throw e;
    } finally {
      setBusy(false);
    }
  };

  const remove = () =>
    withBusy(async () => {
      if (!window.confirm('Delete this document, its file and its extracted text?')) return;
      await deleteDocument(api, docId);
      onDeleted();
    });

  if (!current) {
    return <div className="panel">{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</div>;
  }

  const { doc, etag } = current;
  return (
    <div className="panel detail">
      <div className="panel-head">
        <h2>{doc.title ?? doc.filename}</h2>
        <StatusPill status={doc.status} />
      </div>
      {error && <p className="error">{error}</p>}
      {doc.status === 'queued' && <p className="muted pulse">Waiting for the worker to extract the text…</p>}
      {doc.status === 'failed' && <p className="error">Extraction failed: {doc.error ?? 'no reason given'}</p>}

      <dl className="facts">
        <dt>Document ID</dt>
        <dd>
          <code>{doc.doc_id}</code>
        </dd>
        <dt>File</dt>
        <dd>
          {doc.filename} · {doc.content_type} · {formatBytes(doc.size_bytes)}
        </dd>
        <dt>Uploaded</dt>
        <dd>{formatTime(doc.created_at)}</dd>
        <dt>Extracted</dt>
        <dd>
          {formatTime(doc.extracted_at)}
          {doc.extracted_at && (
            <span className="muted"> ({formatElapsed(doc.created_at, doc.extracted_at)} after upload)</span>
          )}
        </dd>
        <dt>Updated</dt>
        <dd>{formatTime(doc.updated_at)}</dd>
        <dt>Tags</dt>
        <dd>
          {doc.tags.length
            ? doc.tags.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))
            : '—'}
        </dd>
        <dt>Metadata</dt>
        <dd>
          {Object.keys(doc.metadata).length
            ? Object.entries(doc.metadata).map(([key, value]) => (
                <div key={key}>
                  <code>{key}</code> = {String(value)}
                </div>
              ))
            : '—'}
        </dd>
        <dt>ETag</dt>
        <dd>
          <code>{etag ?? '—'}</code>
        </dd>
      </dl>

      <div className="actions">
        <button onClick={() => void openContent(false)} disabled={busy}>
          Open original
        </button>
        <button onClick={() => void openContent(true)} disabled={busy}>
          Download
        </button>
        <button onClick={() => void reload()} disabled={busy}>
          Reload
        </button>
        <button className="danger" onClick={() => void remove()} disabled={busy}>
          Delete
        </button>
      </div>

      <h3>Extracted text</h3>
      {doc.status !== 'succeeded' ? (
        <p className="muted">Available once extraction succeeds.</p>
      ) : text === null ? (
        <p className="muted">Loading…</p>
      ) : 'error' in text ? (
        <p className="error">{text.error}</p>
      ) : (
        <>
          <p className="muted">
            {text.value.length.toLocaleString()} characters{' '}
            <button className="link" onClick={() => void navigator.clipboard.writeText(text.value)}>
              Copy
            </button>
          </p>
          <pre className="text">{text.value || '(empty)'}</pre>
        </>
      )}

      <h3>Edit</h3>
      <EditForm doc={doc} onSave={save} disabled={busy} />

      <details>
        <summary>Response JSON</summary>
        <pre className="json">{JSON.stringify(doc, null, 2)}</pre>
      </details>
    </div>
  );
}
