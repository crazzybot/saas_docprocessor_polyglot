import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import type { EntraSession } from './auth';
import { loadConfig } from './config';
import './styles.css';

const root = createRoot(document.getElementById('root')!);

try {
  const config = await loadConfig();
  // Before the first render: completes a sign-in redirect if this load is one.
  // MSAL is most of the bundle, so local mode never downloads it.
  const entra: EntraSession | null =
    config.auth.mode === 'entra' ? await (await import('./auth')).startEntraSession(config.auth) : null;
  root.render(
    <StrictMode>
      <App config={config} entra={entra} />
    </StrictMode>,
  );
} catch (error) {
  root.render(
    <main className="fatal">
      <h1>The test client could not start</h1>
      <p>{error instanceof Error ? error.message : String(error)}</p>
      <p>Check the config.json served next to the page.</p>
    </main>,
  );
}
