# Task runner for the polyglot monorepo: one entry point for both toolchains.
# `just` lists the recipes. Language-specific recipes are prefixed ts- / py-;
# the unprefixed ones (check, test, lint, ...) run both.

set shell := ["bash", "-euo", "pipefail", "-c"]

# pnpm at the version pinned in package.json's packageManager field.
pnpm := "corepack pnpm"
export COREPACK_ENABLE_DOWNLOAD_PROMPT := "0"

# A virtualenv activated in the calling shell would make uv warn and ignore it.
unexport VIRTUAL_ENV

registry := "acrdocprocessorap.azurecr.io"
services := "document-service worker-service"

# The Python contract generator runs as a pinned, isolated tool (its own
# pydantic pin would otherwise constrain the services').
datamodel_codegen := "uvx --from datamodel-code-generator==0.83.0 --with ruff==0.16.10 datamodel-codegen"
codegen_flags := "--input contracts/schemas --input-file-type jsonschema --output-model-type pydantic_v2.BaseModel --target-python-version 3.11 --use-annotated --field-constraints --use-default --use-schema-description --use-field-description --output-datetime-class AwareDatetime --extra-fields ignore --enum-field-as-literal all --disable-timestamp --use-double-quotes --use-standard-collections --use-union-operator --formatters ruff-format ruff-check"
py_generated := "libs/py-shared/docprocessor_shared/generated"

[private]
default:
    @{{ just_executable() }} --list --unsorted

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

# Install both toolchains' dependencies from their lockfiles
install:
    {{ pnpm }} install --frozen-lockfile
    uv sync --locked --all-packages

# ---------------------------------------------------------------------------
# Contracts: contracts/schemas is the source of truth for the messages, and
# the document service's zod schemas for contracts/openapi.json (HTTP API)
# ---------------------------------------------------------------------------

# Regenerate the message types and models, and the OpenAPI document
contracts:
    node scripts/generate-ts-contracts.mjs
    rm -rf {{ py_generated }}
    {{ datamodel_codegen }} {{ codegen_flags }} --output {{ py_generated }}
    {{ just_executable() }} ts-build
    node scripts/generate-openapi.mjs

# Fail if any generated contract is out of date with its source
contracts-check:
    #!/usr/bin/env bash
    set -euo pipefail
    node scripts/generate-ts-contracts.mjs --check
    {{ just_executable() }} ts-build
    node scripts/generate-openapi.mjs --check
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    {{ datamodel_codegen }} {{ codegen_flags }} --output "$tmp/generated" 2>/dev/null
    if ! diff -r --exclude=__pycache__ --exclude=.ruff_cache "$tmp/generated" {{ py_generated }}; then
        echo "{{ py_generated }} is out of date: run \`just contracts\`" >&2
        exit 1
    fi

# ---------------------------------------------------------------------------
# Checks across both languages
# ---------------------------------------------------------------------------

# Everything CI checks, except the image builds
check: contracts-check lint fmt-check typecheck test

# Lint TypeScript (ESLint) and Python (ruff)
lint: ts-lint py-lint

# Format everything
fmt: ts-fmt py-fmt

# Check formatting without writing
fmt-check: ts-fmt-check py-fmt-check

# Typecheck the TypeScript projects
typecheck: ts-typecheck

# Run both test suites (PostgreSQL tests run only when TEST_DATABASE_URL is set)
test: ts-test py-test

# ---------------------------------------------------------------------------
# TypeScript: libs/ts-shared, services/document-service
# ---------------------------------------------------------------------------

# Compile ts-shared and the TypeScript services to dist/
ts-build:
    {{ pnpm }} -r build

# Typecheck sources and tests
ts-typecheck:
    {{ pnpm }} run typecheck

# ESLint (type-aware: needs ts-shared's compiled declarations, hence the build)
ts-lint: ts-build
    {{ pnpm }} exec eslint .

ts-fmt:
    {{ pnpm }} exec prettier --write .

ts-fmt-check:
    {{ pnpm }} exec prettier --check .

# vitest; extra args are passed through
ts-test *args:
    {{ pnpm }} exec vitest run {{ args }}

# The PostgreSQL repository tests against a throwaway container
test-postgres port="55432":
    #!/usr/bin/env bash
    set -euo pipefail
    name=docprocessor-test-postgres
    docker run --rm -d --name "$name" -p {{ port }}:5432 -e POSTGRES_PASSWORD=pw postgres:16-alpine >/dev/null
    trap 'docker rm -f "$name" >/dev/null' EXIT
    until docker exec "$name" pg_isready -U postgres >/dev/null 2>&1; do sleep 0.5; done
    TEST_DATABASE_URL=postgresql://postgres:pw@127.0.0.1:{{ port }}/postgres \
        {{ pnpm }} exec vitest run services/document-service/test/postgres-repository.test.ts

# ---------------------------------------------------------------------------
# Python: libs/py-shared, services/worker-service
# ---------------------------------------------------------------------------

py-lint:
    uv run ruff check .

py-fmt:
    uv run ruff format .
    uv run ruff check --fix .

py-fmt-check:
    uv run ruff format --check .

# pytest; extra args are passed through
py-test *args:
    uv run pytest -q {{ args }}

# ---------------------------------------------------------------------------
# Running locally
# ---------------------------------------------------------------------------

# Start only the dependencies (PostgreSQL, Azurite, Service Bus emulator) for `just dev`
deps:
    docker compose up -d postgres azurite sqledge servicebus-emulator

# Run one service from source (reads .env): document-service restarts on change
dev service:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{ service }}" in
        document-service)
            {{ just_executable() }} ts-build
            {{ pnpm }} exec tsc -b services/document-service --watch --preserveWatchOutput &
            trap 'kill $!' EXIT
            node --enable-source-maps --watch services/document-service/dist/main.js
            ;;
        worker-service)
            uv run worker-service
            ;;
        *) echo "unknown service: {{ service }} (expected one of: {{ services }})" >&2; exit 2 ;;
    esac

# Run the full stack (dependencies, both services, Aspire Dashboard) in Docker
up *args:
    docker compose up --build {{ args }}

# Stop the stack and delete its volumes
down:
    docker compose down -v

# Follow one service's JSON logs, e.g. `just logs worker | jq -c 'select(.level=="ERROR")'`
logs service:
    docker compose logs -f --no-log-prefix {{ service }}

# Upload sample.pdf to the running stack and walk through the document API
demo base="http://localhost:8000" tenant="acme":
    #!/usr/bin/env bash
    set -euo pipefail
    H="X-Tenant-ID: {{ tenant }}"
    ID=$(curl -sf -H "$H" -F "file=@sample.pdf;type=application/pdf" {{ base }}/documents | jq -r .doc_id)
    echo "uploaded $ID"
    for _ in $(seq 1 30); do
        STATUS=$(curl -sf -H "$H" {{ base }}/documents/$ID | jq -r .status)
        echo "status: $STATUS"
        [ "$STATUS" != queued ] && break
        sleep 1
    done
    curl -sf -H "$H" {{ base }}/documents/$ID/text | head -5
    curl -sf -H "$H" -X PATCH -H 'Content-Type: application/json' -d '{"tags":["demo"]}' {{ base }}/documents/$ID | jq -c '{doc_id, tags}'
    curl -sf -H "$H" "{{ base }}/documents?limit=10" | jq -c '[.items[] | {doc_id, status}]'
    curl -sf -o /dev/null -w "delete: %{http_code}\n" -H "$H" -X DELETE {{ base }}/documents/$ID

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# Build one service's image (arm64, like the AKS nodes) from the repository root, e.g. `just image worker-service 1.1.0`
image service tag="dev":
    docker build --platform linux/arm64 -f services/{{ service }}/Dockerfile -t {{ registry }}/{{ service }}:{{ tag }} .

# Build both images
images tag="dev":
    for s in {{ services }}; do {{ just_executable() }} image "$s" {{ tag }}; done

# Import each image's entry point (catches dependencies missing from the image)
smoke tag="dev":
    docker run --rm --entrypoint node {{ registry }}/document-service:{{ tag }} --input-type=module \
        -e "await import('./dist/app.module.js'); await import('./dist/infrastructure.js')"
    docker run --rm --entrypoint python {{ registry }}/worker-service:{{ tag }} \
        -c "import worker_service.main, pytesseract; print(pytesseract.get_tesseract_version())"

# ---------------------------------------------------------------------------
# Infrastructure (Terraform, infra/): plan and apply sign in with the Azure
# CLI locally, and with OIDC in CI
# ---------------------------------------------------------------------------

# Format, validate and plan-test the Terraform without Azure credentials
infra-check:
    terraform -chdir=infra fmt -check -recursive
    terraform -chdir=infra init -backend=false -input=false
    terraform -chdir=infra validate
    terraform -chdir=infra test
    terraform -chdir=infra/bootstrap init -backend=false -input=false
    terraform -chdir=infra/bootstrap validate

# Plan one environment into infra/<env>.tfplan, e.g. `just infra-plan prod`
infra-plan env:
    terraform -chdir=infra init -input=false -reconfigure -backend-config=envs/{{ env }}.backend.hcl
    terraform -chdir=infra plan -input=false -var-file=envs/{{ env }}.tfvars -out={{ env }}.tfplan

# Apply the plan saved by `just infra-plan <env>`
infra-apply env:
    terraform -chdir=infra apply -input=false {{ env }}.tfplan

# Destroy one environment but not the bootstrap; asks for "yes" after the plan
infra-destroy env:
    terraform -chdir=infra init -input=false -reconfigure -backend-config=envs/{{ env }}.backend.hcl
    terraform -chdir=infra destroy -var-file=envs/{{ env }}.tfvars
