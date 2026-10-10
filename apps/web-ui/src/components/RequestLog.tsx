import { useState, useSyncExternalStore } from 'react';

import { requestLog } from '../api';

/**
 * Every API call this page made, with its correlation ID: search for it in
 * the services' JSON logs (`just logs worker | jq -c 'select(.correlation_id=="…")'`)
 * or in the Aspire Dashboard / Azure Monitor to see the whole trace.
 */
export function RequestLog() {
  const entries = useSyncExternalStore(requestLog.subscribe, requestLog.snapshot);
  const [open, setOpen] = useState(false);
  const failures = entries.filter((e) => e.error !== null || (e.status !== null && e.status >= 400)).length;

  return (
    <footer className={`request-log${open ? ' open' : ''}`}>
      <div className="log-head">
        <button className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'} Requests ({entries.length}
          {failures > 0 && <span className="error-count">, {failures} failed</span>})
        </button>
        {open && entries.length > 0 && (
          <button className="link" onClick={() => requestLog.clear()}>
            Clear
          </button>
        )}
      </div>
      {open && (
        <div className="log-body">
          <table>
            <thead>
              <tr>
                <th>Method</th>
                <th>Path</th>
                <th>Status</th>
                <th>Time</th>
                <th>Correlation ID</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const failed = entry.error !== null || (entry.status !== null && entry.status >= 400);
                return (
                  <tr key={entry.id} className={failed ? 'failed' : undefined}>
                    <td>{entry.method}</td>
                    <td className="path">{entry.path}</td>
                    <td>{entry.error ? `network: ${entry.error}` : (entry.status ?? '…')}</td>
                    <td>{entry.durationMs === null ? '' : `${Math.round(entry.durationMs)} ms`}</td>
                    <td>
                      <button
                        className="link mono"
                        title="Copy"
                        onClick={() => void navigator.clipboard.writeText(entry.correlationId)}
                      >
                        {entry.correlationId}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </footer>
  );
}
