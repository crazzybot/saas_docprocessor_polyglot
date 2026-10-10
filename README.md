# SaaS Document Processor (polyglot monorepo)

A two-service, event-driven pipeline for a multi-tenant SaaS product, built
as a **polyglot monorepo**: each service is written in the language that
suits it, and both share one repository, one task runner, one CI pipeline,
and one set of message contracts.

| Service | Language | What it does |
|---|---|---|
| `services/document-service` | TypeScript (NestJS 12, Node 24) | HTTP API: upload, document catalog (PostgreSQL), content and text access; publishes lifecycle events through a transactional outbox; consumes extraction results. |
| `services/worker-service` | Python 3.11 (asyncio) | Consumes extraction jobs, extracts text (PyMuPDF, python-docx, Tesseract OCR), stores the result, and publishes a completion event. |

A third, optional piece is a test client: [`apps/web-ui`](apps/web-ui/), a
React SPA for trying the pipeline by hand. It isn't part of the product (see
[its README](apps/web-ui/README.md)).

The split plays to each ecosystem's strengths: a typed web framework for the
API, and Python's document-processing (and, later, AI) libraries for the
worker. The services never call each other. They talk only through Azure
Service Bus messages and Blob Storage, and the messages are defined once, in
[`contracts/`](contracts/).

The services come from two single-language sibling repos,
`../saas_docprocessor` (Python) and `../saas_docprocessor_nestjs`
(TypeScript), which implement the same system and stay wire-compatible with
this one.

```
  Client ──HTTPS──▶ Gateway (AKS app routing, Gateway API) ──▶ document-service (TypeScript)
                                        │  1. raw file ──▶ Blob: raw-documents
                                        │  2. document + event, one transaction ──▶ PostgreSQL (documents, outbox)
                                        │  3. outbox relay ──▶ topic document-events
                                        │                        └─ sub "extraction" (uploaded only) ──ForwardTo──▶ queue extraction-jobs
                                        │                                                                              │
                                        │                                         worker-service (Python) ◀───────────┘ 4.
                                        │                                           5. download raw blob
                                        │                                           6. extract text → Blob: extraction-results
                                        │  8. status ← sub "document-service" ◀── 7. topic extraction-results
```

## Quick start

You need Node.js 24, Python 3.11, [uv](https://docs.astral.sh/uv/),
[just](https://just.systems), and Docker. `mise install` sets up all of them
from [mise.toml](mise.toml); or install them yourself (`brew install uv just`).
pnpm comes from Corepack, pinned by `packageManager` in `package.json`.

```bash
just install          # pnpm install --frozen-lockfile && uv sync --locked --all-packages
just check            # contracts in sync, lint, format, typecheck, both test suites
just up               # the whole system in Docker, with the Azure emulators
just demo             # in another terminal: upload sample.pdf and walk through the API
                      # or open http://localhost:3000 for the web test client
```

`just` with no arguments lists every recipe.

## Repository layout

```
saas_docprocessor_polyglot/
├── contracts/                    the contracts, language-neutral
│   ├── schemas/*.schema.json     JSON Schema (draft 2020-12), one per message: source of truth
│   ├── examples/<message>/{valid,invalid}/*.json   golden messages both languages' tests run
│   └── openapi.json              the document service's HTTP API (OpenAPI 3.1) · GENERATED
├── services/
│   ├── document-service/         TypeScript · pnpm workspace member · NestJS
│   │   ├── src/                  domain / application / adapters / api, composition root
│   │   ├── test/                 vitest: API, background tasks, PostgreSQL, layering, contracts
│   │   └── Dockerfile
│   └── worker-service/           Python · uv workspace member
│       ├── worker_service/       consumer, processing, extractors, health, metrics
│       ├── tests/                pytest: processing, consumer, contracts
│       ├── pyproject.toml
│       └── Dockerfile
├── apps/
│   └── web-ui/                   TypeScript · pnpm workspace member · React + Vite test client
│       ├── src/generated/        API types from contracts/openapi.json · GENERATED
│       ├── nginx/                the image's server config, and the Compose-only API proxy
│       └── Dockerfile
├── libs/
│   ├── ts-shared/                @docprocessor/shared: contracts (Ajv over the schemas), settings,
│   │   └── src/generated/        Azure clients, JSON logging, telemetry, shutdown · GENERATED types
│   └── py-shared/                docprocessor-shared: contracts (pydantic), settings, Azure clients,
│       └── docprocessor_shared/generated/            logging, telemetry · GENERATED models
├── scripts/                      generate-ts-contracts.mjs, generate-openapi.mjs, copy-assets.mjs
├── justfile                      the one entry point for both toolchains
├── package.json, pnpm-workspace.yaml, pnpm-lock.yaml, tsconfig*.json   TypeScript workspace
├── pyproject.toml, uv.lock, ruff.toml, .python-version                 Python workspace
├── mise.toml, .nvmrc             toolchain versions
├── docker-compose.yml (+ override)   the whole system locally, with emulators and a trace UI
├── k8s/                          AKS manifests
├── infra/                        Terraform: the Azure environment (AKS, Service Bus, Storage, PostgreSQL, ...)
└── .github/workflows/ci.yml      per-toolchain jobs behind path filters, contracts check, images
```

### How the two toolchains share the repository

- **Each language keeps its native tooling.** pnpm manages the TypeScript
  workspace (`pnpm-workspace.yaml` lists its members) and uv manages the
  Python one (`[tool.uv.workspace]` in the root `pyproject.toml`). Each has
  one lockfile at the root, so every TypeScript project shares one
  resolution, and so does every Python project. Neither tool looks at the
  other's directories.
- **`libs/` holds one shared library per language.** Code can't be shared
  across languages, so `ts-shared` and `py-shared` implement the same
  conventions instead: the same JSON log fields (`timestamp`, `level`,
  `logger`, `message`, `correlation_id`, `trace_id`, `span_id`), the same
  environment variable names, the same span and metric names, and W3C
  trace-context propagation through message application properties. That's
  why one OpenTelemetry trace runs from the TypeScript upload into the
  Python worker.
- **`just` is the language-neutral entry point.** Recipes prefixed `ts-` and
  `py-` run one toolchain. The unprefixed ones (`check`, `lint`, `fmt`,
  `test`) run both. CI calls the same recipes.
- **Docker, Compose and Kubernetes don't care about language.** Each service
  has its own Dockerfile (built from the repository root, since it needs its
  workspace and shared library), and the manifests treat both alike.

## Message contracts

The two services agree on two messages:

| Message | Producer → consumer | Schema |
|---|---|---|
| `document.uploaded` (the job) | document service (TS) → topic `document-events` → queue `extraction-jobs` → worker (Py) | [document-uploaded.schema.json](contracts/schemas/document-uploaded.schema.json) |
| extraction completed | worker (Py) → topic `extraction-results` → document service (TS) | [extraction-completed.schema.json](contracts/schemas/extraction-completed.schema.json) |

**JSON Schema is the source of truth**, and each language generates code
from it:

| | TypeScript (`libs/ts-shared`) | Python (`libs/py-shared`) |
|---|---|---|
| Generated | `src/generated/contracts.ts`: an interface per message ([json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript)) plus the schema itself | `docprocessor_shared/generated/*.py`: a pydantic model per message ([datamodel-code-generator](https://github.com/koxudaxi/datamodel-code-generator)) |
| Validation at runtime | Ajv against the embedded schema (fills defaults) | the pydantic model |
| Hand-written on top | `contracts.ts`: message IDs, blob-name resolution, defaults | `contracts.py`: subclasses adding the same, plus the cross-field rule |

The generated files are committed, so builds don't need the generators.

**Changing a contract:**

1. Edit `contracts/schemas/*.schema.json`. Changes must be **additive**:
   never rename or remove a field, and give every new field a default.
   Readers ignore fields they don't know, so either service can deploy first.
2. Add or adjust golden messages in `contracts/examples/<message>/valid` or
   `invalid`.
3. Run `just contracts` to regenerate both languages' code, then
   `just check`.

**What guards the contracts:**

- `just contracts-check` (its own CI job) regenerates both languages' code
  and fails if anything differs from what's committed.
- Every golden example is run through **both** languages: through Ajv and the
  TypeScript contract layer (`libs/ts-shared/test/contracts.test.ts`), and
  through the JSON Schema and the pydantic models
  (`libs/py-shared/tests/test_contracts.py`). Valid examples must pass and
  invalid ones fail, identically.
- Each service checks its own side. The document service applies every
  valid completion event and dead-letters every invalid one, and its
  `document.uploaded` output parses as a job
  (`services/document-service/test/contracts.test.ts`). The worker accepts
  every valid job, rejects every invalid one, and its published completion
  events validate against the schema
  (`services/worker-service/tests/test_contracts.py`).
- Field-name tests pin the wire names, so a rename fails loudly.

One rule doesn't survive code generation: a job needs `blob_name` or
`blob_url` (the schema's `not` clause). Ajv enforces it in TypeScript, and a
model validator in `contracts.py` enforces it in Python. The golden example
`invalid/no-location.json` checks both.

Bodies travel as UTF-8 JSON in the AMQP data section, which both Service Bus
SDKs read back as the same text.

## HTTP API contract

[`contracts/openapi.json`](contracts/openapi.json) describes the document
service's HTTP API (OpenAPI 3.1) for clients: SDK generation, docs, mocks.
Unlike the message schemas, it is **generated from the service**, since only
one service implements it. The zod schemas in
`services/document-service/src/api/schemas.ts` validate requests and type
responses, and `src/api/openapi.ts` lists the operations and builds the
document from those schemas (with the default settings, so page and upload
limits are the defaults).

**Changing the API:** change the schemas and the controller, update the
operation in `openapi.ts`, then run `just contracts` and `just check`. The
same additive rule applies: responses gain fields, never lose or rename
them. The published schemas don't forbid unknown fields, so clients that
validate keep working when one is added.

**What guards it:**

- `just contracts-check` rebuilds the service and fails if `openapi.json`
  differs from what's committed.
- `services/document-service/test/openapi.test.ts` checks that the document
  lists exactly the controllers' routes, and that real responses (successes,
  validation, auth and conflict errors) have a documented status, the
  documented headers, and bodies that match their schema with no
  undocumented fields (the zod response schemas are strict).

## Services

### document-service (TypeScript)

All endpoints except the probes require an Entra ID bearer token and are
scoped to the token's tenant (`tid`, which must be on
`AZURE_AD_ALLOWED_TENANT_IDS`). Error bodies are `{"detail": ...}`.

| Endpoint | Purpose |
|---|---|
| `POST /documents` | Multipart upload (`file`). **202** with the document, `Location`, and `ETag`. PDF, DOCX, PNG, or JPEG, checked by magic bytes; max `MAX_UPLOAD_SIZE_MB`. |
| `GET /documents` | The tenant's documents, newest first: `limit`, `cursor`, `status`. |
| `GET /documents/{id}` | One document, with `ETag` and links. |
| `PATCH /documents/{id}` | Merge-patch `title`, `tags`, `metadata`; honours `If-Match` (**412** when stale). |
| `DELETE /documents/{id}` | Tombstones the document and removes its blobs; **204**. |
| `GET /documents/{id}/content` | Streams the original file. |
| `GET /documents/{id}/text` | The extracted text; **409** until extraction succeeds. |
| `POST /upload` | Deprecated alias of `POST /documents`. |
| `GET /healthz`, `GET /readyz` | Probes; readiness checks PostgreSQL and Blob Storage. |

An upload writes the blob, then the document and its `document.uploaded`
event in one PostgreSQL transaction (transactional outbox). An outbox relay
in each replica publishes events afterwards (`FOR UPDATE SKIP LOCKED`,
at-least-once, deduplicated by message ID on the topic), so a Service Bus
outage delays extraction but never fails an upload. A results consumer moves
documents from `queued` to `succeeded` or `failed`; status only moves
forward. A maintenance loop retries blob cleanup and purges old tombstones
and outbox rows.

Code is layered (`domain` ← `application` ← `adapters`, `api`), and
`test/architecture.test.ts` enforces it. Nest provides the HTTP layer and
lifecycle; `infrastructure.ts` wires the adapters.

### worker-service (Python)

An asyncio consumer of `extraction-jobs`. At most `MAX_CONCURRENCY` messages
are in flight, each with its lock renewed while a slow OCR job runs.
Extraction runs in a thread (`asyncio.to_thread`): PDF with PyMuPDF, DOCX
with python-docx, PNG and JPEG with Tesseract. The result goes to
`extraction-results/{tenant_id}/{doc_id}.json`, followed by a `succeeded`
event.

- **Permanent failures** (malformed job, unsupported type, missing blob, any
  extractor error): a `failed` event is published, then the message is
  dead-lettered.
- **Transient failures**: the message is abandoned for redelivery, then
  dead-lettered with a `failed` event after `MAX_DELIVERY_ATTEMPTS`.
- **Health**: `/healthz` on `:8080` fails when the receive loop's heartbeat
  goes stale; `/readyz` also needs a connected receiver. Metrics are on
  `:9100/metrics` (`messages_processed_total`, `extraction_duration_seconds`).
- **Reconnects and shutdown**: connection failures are retried with
  exponential backoff. SIGTERM drains in-flight jobs and exits 0.

## Configuration

Both services read environment variables, plus an optional `.env` in the
working directory (see [.env.example](.env.example)). The variable names are
shared across languages: the Azure access, container, and topic settings are
defined once per language in `libs/*-shared` and read the same variables. In
AKS everything comes from [k8s/configmap.yaml](k8s/configmap.yaml), and none
of it is secret: Storage, Service Bus, and PostgreSQL all use Workload
Identity.

## Local development

```bash
just up                          # PostgreSQL, Azurite, Service Bus emulator, both services, web UI, Aspire Dashboard
                                 # (POSTGRES_HOST_PORT=5433 just up if 5432 is taken)
just demo                        # upload sample.pdf, poll, read text, patch, list, delete
open http://localhost:3000       # the same by hand in the web test client
just logs worker | jq -c 'select(.correlation_id=="<id>")'
just down                        # stop and delete volumes
```

Traces and logs from both services go to the Aspire Dashboard at
<http://localhost:18888>. An upload shows up as one trace crossing the
language boundary: `POST /documents` → `upload_document` (TypeScript) →
`process_extraction_job` → `download_blob`, `extract_text`, `upload_result`
(Python).

To run a service from source against the emulators:

```bash
cp .env.example .env
just deps                        # only the dependencies
just dev document-service        # tsc --watch + node --watch on :8000
just dev worker-service          # uv run worker-service (health :8080, metrics :9100; needs tesseract for OCR)
just dev web-ui                  # Vite on :5173 with hot reload, proxying /documents to :8000
```

### Checks and tests

```bash
just check                       # everything CI runs, except image builds
just ts-test services/document-service   # one toolchain, extra args to vitest
just py-test -k contracts                # extra args to pytest
just test-postgres               # PostgreSQL repository tests against a throwaway container
just fmt                         # Prettier + ruff format
```

### Dependencies

```bash
corepack pnpm --filter @docprocessor/document-service add some-package   # TypeScript service
corepack pnpm --filter @docprocessor/shared add some-package             # ts-shared
uv add --package worker-service some-package                             # Python service
uv add --package docprocessor-shared some-package                        # py-shared
```

Commit the lockfile that changed. CI's `--frozen-lockfile` and `--locked`
installs fail if a lockfile is out of date.

### Adding a service

1. Create `services/<name>/` with the language's manifest (`package.json` or
   `pyproject.toml`).
2. Register it in the language's workspace (`pnpm-workspace.yaml`, or
   `members` in the root `pyproject.toml`), depending on `libs/ts-shared` or
   `libs/py-shared` for logging, telemetry, settings, and contracts.
3. Add a Dockerfile built from the repository root, a Compose service, k8s
   manifests, and a matrix entry and path filter in CI.
4. If it exchanges new messages, start with a schema in `contracts/`.

## CI

[.github/workflows/ci.yml](.github/workflows/ci.yml):

- **changes**: path filters decide which toolchains a change touches.
  `contracts/`, the `justfile`, and the workflow count for both.
- **contracts**: always runs `just contracts-check`.
- **typescript**: lint, format, typecheck, and tests (with a PostgreSQL
  service container), only when TypeScript files changed.
- **python**: ruff and pytest, only when Python files changed.
- **docker-build**: builds each affected image and smoke-tests it (imports
  the service's entry point; checks tesseract in the worker image and the
  nginx config in the web UI image).

## Building images

```bash
just image document-service 2.0.0   # docker build -f services/document-service/Dockerfile … from the repo root
just image worker-service 1.1.0
just image web-ui 0.1.0
just images && just smoke            # all three, then smoke-test each
```

- The TypeScript image fetches packages from the lockfile, compiles with
  `tsc`, and ships a `pnpm deploy --prod` tree.
- The Python image installs third-party wheels from `uv.lock` in a cached
  layer, then the worker and `docprocessor-shared` as regular (non-editable)
  packages, and ships only the virtualenv.
- Both run as uid 10001 with root-owned, read-only application files, and
  both define a `HEALTHCHECK`.

## Kubernetes deployment

The manifests in `k8s/` (namespace with the restricted Pod Security
Standard, Workload Identity service account, ConfigMap, both Deployments,
HPA for the document service, KEDA ScaledObject for the worker,
PodDisruptionBudget, PodMonitor, NetworkPolicies) are unchanged from the
single-language repos and don't depend on either language. Public traffic
enters through a Gateway API `Gateway` served by the AKS application routing
add-on (`approuting-istio`, AKS 1.36+), with TLS from cert-manager; see the
prerequisites at the top of [k8s/gateway.yaml](k8s/gateway.yaml). It replaces
the retired ingress-nginx; rate limiting, which that add-on doesn't offer,
belongs in document-service.

```bash
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/serviceaccount.yaml -f k8s/configmap.yaml
kubectl apply -f k8s/document_service_deployment.yaml -f k8s/worker_deployment.yaml
kubectl apply -f k8s/network_policy.yaml -f k8s/poddisruptionbudget.yaml -f k8s/pod_monitor.yaml
kubectl apply -f k8s/hpa.yaml -f k8s/keda_scaledobject.yaml
kubectl apply -f k8s/cluster_issuer.yaml -f k8s/gateway.yaml -f k8s/httproute.yaml
```

The web test client is applied on its own, and only to environments meant
for testing: `kubectl apply -f k8s/web_ui.yaml`. It's served at the app host
through the Gateway's `https-app` listener; remove that listener from
`gateway.yaml` where the client isn't deployed. Setup (DNS, the Entra
redirect URI, `config.json`) is in [apps/web-ui/README.md](apps/web-ui/README.md).

The Azure side (cluster and add-ons, managed identities and RBAC roles,
Service Bus entities, PostgreSQL with Entra auth, private networking) is
Terraform in [`infra/`](infra/); its README walks through a first deployment
and `terraform output k8s_values` prints the values the manifests'
placeholders stand for. The API app registration and the per-customer
tenant onboarding are described in the Python repository's README, under
"Kubernetes deployment".

## Known limitations

- **Shared conventions aren't shared code.** Log fields, env var names, and
  span names are kept consistent by hand across `libs/ts-shared` and
  `libs/py-shared`. The contracts are the only part generated from one source.
- **Only the two cross-service messages have schemas.** `document.updated`
  and `document.deleted` are published for downstream consumers but have no
  schema in `contracts/` yet. Add them there before another service consumes
  them.
- **Spans without a collector** differ by language: the Python worker prints
  them to the console, and the TypeScript service only does so with
  `OTEL_TRACES_EXPORTER=console`.
- **Contributors need both toolchains.** `mise install` (or a devcontainer)
  keeps that to one command.
- **No task caching or dependency-graph builds.** CI selects toolchains by
  path, not by the project graph. If the number of services grows, Nx (with
  a Python plugin), Pants, or Bazel can add affected-only runs and caching;
  the layout already fits them.
- See the source repositories' READMEs for each service's own limitations
  (uploads buffered in memory, a static tenant allow-list, and so on).
