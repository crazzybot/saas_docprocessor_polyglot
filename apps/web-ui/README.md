# Web test client

A small React SPA for trying the document pipeline by hand. It isn't the
product's front end. It's for developers and testers.

- **Upload**: drag and drop one or more files to `POST /documents`.
- **Follow a document**: the detail view polls `GET /documents/{id}` while
  the document is `queued`, then shows when it was extracted and how long
  that took, or the failure reason.
- **Read the result**: the extracted text (`/text`), and the original file
  (`/content`) to open or download.
- **Edit and delete**: title, tags and metadata as a JSON merge patch sent
  with `If-Match`, so you can see a 412 when someone else changed the
  document first.
- **List**: newest first, filtered by status, with cursor paging. The list
  refreshes on its own while anything in it is still queued.
- **Requests panel**: every call with its status, timing and
  `X-Correlation-ID`. Search the services' logs or traces for that ID to
  follow one request through the TypeScript API and the Python worker.

The API types in `src/generated/api.ts` are generated from
`contracts/openapi.json` (`just contracts`). A change to the API that breaks
the client fails `just typecheck`, and `just contracts-check` fails if the
types are stale.

## Running it

| | Command | URL | Auth |
|---|---|---|---|
| Full stack in Docker | `just up` | <http://localhost:3000> | local |
| Hot reload | `just dev web-ui` (with the API on :8000 from `just up` or `just dev document-service`) | <http://localhost:5173> | local |

In both cases the API is on the page's own origin (nginx in Compose and Vite
in dev proxy `/documents`), so the document service doesn't need CORS
locally. Point Vite somewhere else with `API_PROXY_TARGET`.

## Configuration: `config.json`

The page reads `/config.json` at startup instead of build-time variables,
so one image serves every environment. The image has the local-mode file
from `public/`, and AKS mounts its own from a ConfigMap.

```jsonc
// Local: the API runs with AUTH_ENABLED=false; the tenant goes in X-Tenant-ID.
{ "apiBaseUrl": "", "auth": { "mode": "local", "defaultTenant": "acme" } }

// Azure: sign in with Entra ID (MSAL, auth code + PKCE) and send the token.
{
  "apiBaseUrl": "https://api.docprocessor.example.com",
  "auth": {
    "mode": "entra",
    "clientId": "<test client app registration's client ID>",
    "authority": "https://login.microsoftonline.com/organizations",
    "scopes": ["<API Application ID URI>/Documents.Upload"]
  }
}
```

`apiBaseUrl` is empty when the API is on the same origin. MSAL loads only in
Entra mode.

## Deploying to AKS

[`k8s/web_ui.yaml`](../../k8s/web_ui.yaml) holds the ConfigMap with
`config.json`, the Deployment (unprivileged nginx with a read-only root
filesystem), the Service, an HTTPRoute for `app.docprocessor.example.com`
on the Gateway's `https-app` listener, and a NetworkPolicy that admits only
the Gateway and allows no egress. The browser, not the pod, calls the API,
and the API's HTTPRoute already allows this origin through CORS.

1. Create the test client app registration
   ([docs/entra-identities.md](../../docs/entra-identities.md), step 3) and
   put its client ID and the API scope into `config.json` in `web_ui.yaml`.
2. Point the app host's DNS A record at the Gateway's public IP
   (`terraform -chdir=infra output gateway_public_ip`).
3. Build and push the image: `just image web-ui 0.1.0`, then
   `docker push acrdocprocessorap.azurecr.io/web-ui:0.1.0`.
4. `kubectl apply -f k8s/gateway.yaml -f k8s/web_ui.yaml`. cert-manager
   issues the `docprocessor-app-tls` certificate through the HTTP listener.

Deploy it only to test environments. It gives a tester nothing beyond what
their token already allows, but a test tool doesn't belong in production.
After editing the ConfigMap, bump the `docprocessor/config-revision`
annotation so the pod restarts, because `subPath` mounts don't pick up
changes.
