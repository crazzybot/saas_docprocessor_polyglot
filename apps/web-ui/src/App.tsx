import { useCallback, useEffect, useMemo, useState } from 'react';

import { createApi } from './api';
import type { EntraSession } from './auth';
import { DocumentDetail } from './components/DocumentDetail';
import { DocumentList } from './components/DocumentList';
import { RequestLog } from './components/RequestLog';
import { UploadPanel } from './components/UploadPanel';
import type { AppConfig } from './config';
import { readStored, writeStored } from './storage';

/** The selected document lives in the URL hash, so a reload or a shared link keeps it. */
function selectedFromHash(): string | null {
  const match = /^#\/documents\/([0-9a-fA-F-]{36})$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

export function App({ config, entra }: { config: AppConfig; entra: EntraSession | null }) {
  const [tenant, setTenant] = useState(() =>
    config.auth.mode === 'local' ? (readStored('tenant') ?? config.auth.defaultTenant) : '',
  );
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  // Bumped after any change, so the list reloads.
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);

  const api = useMemo(
    () =>
      createApi(config.apiBaseUrl, async (): Promise<Record<string, string>> => {
        if (entra) return { Authorization: `Bearer ${await entra.accessToken()}` };
        return tenant ? { 'X-Tenant-ID': tenant } : {};
      }),
    [config.apiBaseUrl, entra, tenant],
  );

  useEffect(() => {
    const onHashChange = () => setSelected(selectedFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const select = useCallback((docId: string | null) => {
    window.location.hash = docId ? `#/documents/${docId}` : '';
    setSelected(docId);
  }, []);

  const changeTenant = (value: string) => {
    if (value === tenant) return;
    setTenant(value);
    writeStored('tenant', value);
    select(null);
  };

  if (entra && !entra.account) {
    return (
      <main className="signin">
        <h1>DocProcessor test client</h1>
        <p>Sign in with a work account from an onboarded tenant to call the document API.</p>
        <button className="primary" onClick={() => void entra.signIn()}>
          Sign in with Microsoft
        </button>
      </main>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>DocProcessor test client</h1>
        <div className="identity">
          {entra?.account ? (
            <>
              <span title={`tenant ${entra.account.tenantId}`}>
                {entra.account.username} · tenant <code>{entra.account.tenantId}</code>
              </span>
              <button onClick={() => void entra.signOut()}>Sign out</button>
            </>
          ) : (
            <TenantField tenant={tenant} onChange={changeTenant} />
          )}
          <span className="api-target" title="Document service">
            API <code>{config.apiBaseUrl || window.location.origin}</code>
          </span>
        </div>
      </header>

      <main className="workspace">
        <section className="column">
          <UploadPanel
            api={api}
            onUploaded={(doc) => {
              refresh();
              select(doc.doc_id);
            }}
          />
          <DocumentList key={tenant} api={api} revision={revision} selected={selected} onSelect={select} />
        </section>
        <section className="column">
          {selected ? (
            <DocumentDetail
              key={`${tenant}/${selected}`}
              api={api}
              docId={selected}
              onChanged={refresh}
              onDeleted={() => {
                refresh();
                select(null);
              }}
            />
          ) : (
            <div className="panel empty">Upload a file or pick a document to follow it through the pipeline.</div>
          )}
        </section>
      </main>

      <RequestLog />
    </div>
  );
}

/** Applies on Enter or blur, not per keystroke, so the list reloads once. */
function TenantField({ tenant, onChange }: { tenant: string; onChange: (tenant: string) => void }) {
  const [draft, setDraft] = useState(tenant);
  return (
    <label>
      Tenant (X-Tenant-ID)
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => onChange(draft.trim())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onChange(draft.trim());
        }}
        spellCheck={false}
        size={16}
      />
    </label>
  );
}
