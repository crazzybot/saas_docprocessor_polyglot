import { useCallback, useEffect, useState } from 'react';

import { listDocuments, type Api, type Document, type DocumentStatus } from '../api';
import { formatBytes, formatTime } from '../format';
import { StatusPill } from './StatusPill';

const PAGE_SIZE = 20;
/** While anything listed is still queued, the list refreshes this often. */
const POLL_MS = 3000;

interface Props {
  api: Api;
  /** Changes whenever a document was uploaded, edited or deleted. */
  revision: number;
  selected: string | null;
  onSelect: (docId: string) => void;
}

export function DocumentList({ api, revision, selected, onSelect }: Props) {
  const [status, setStatus] = useState<DocumentStatus | ''>('');
  const [items, setItems] = useState<readonly Document[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // State is set only once the request settles, so effects can call this.
  const load = useCallback(
    (limit: number) =>
      listDocuments(api, { status: status || undefined, limit: Math.min(limit, 100) }).then(
        (page) => {
          setItems(page.items);
          setNextCursor(page.next_cursor);
          setError(null);
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      ),
    [api, status],
  );

  useEffect(() => {
    void load(PAGE_SIZE);
  }, [load, revision]);

  // Polling refetches as many rows as are shown, so it keeps pages already loaded.
  const shown = Math.max(PAGE_SIZE, items.length);
  const anyQueued = items.some((doc) => doc.status === 'queued');
  useEffect(() => {
    if (!anyQueued) return;
    const timer = window.setInterval(() => void load(shown), POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyQueued, load, shown]);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoading(true);
    try {
      const page = await listDocuments(api, { status: status || undefined, cursor: nextCursor, limit: PAGE_SIZE });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Documents</h2>
        <div className="toolbar">
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as DocumentStatus | '')}
            aria-label="Filter by status"
          >
            <option value="">All statuses</option>
            <option value="queued">Queued</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
          </select>
          <button
            onClick={() => {
              setLoading(true);
              void load(shown).finally(() => setLoading(false));
            }}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {items.length === 0 && !error ? (
        <p className="muted">No documents for this tenant yet.</p>
      ) : (
        <ul className="doc-list">
          {items.map((doc) => (
            <li key={doc.doc_id}>
              <button
                className={`doc-row${doc.doc_id === selected ? ' selected' : ''}`}
                onClick={() => onSelect(doc.doc_id)}
              >
                <span className="name">{doc.title ?? doc.filename}</span>
                <StatusPill status={doc.status} />
                <span className="muted">
                  {formatBytes(doc.size_bytes)} · {formatTime(doc.created_at)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {nextCursor && (
        <button className="more" onClick={() => void loadMore()} disabled={loading}>
          Load more
        </button>
      )}
    </div>
  );
}
