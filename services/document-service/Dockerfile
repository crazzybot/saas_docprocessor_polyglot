# syntax=docker/dockerfile:1.7
# Build context MUST be the repository root, so the workspace (lockfile and
# libs/ts-shared) is available:
#   docker build -f services/document-service/Dockerfile -t document-service:latest .

# ---------- Stage 1: build --------------------------------------------------
FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo

# Fill the package store from the lockfile alone, so this layer is cached
# until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile

# Install this service's dependency closure, compile shared + the service,
# then copy out a production-only tree (dist/ + pruned node_modules).
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@docprocessor/document-service..." \
    && pnpm --filter "@docprocessor/document-service..." run build \
    && pnpm --filter @docprocessor/document-service deploy --legacy --prod /out

# ---------- Stage 2: runtime ------------------------------------------------
FROM node:24-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="saas-docprocessor-document-service" \
      org.opencontainers.image.description="Document API (upload, catalog, content) for the SaaS document processing platform" \
      org.opencontainers.image.source="https://example.invalid/saas_docprocessor_polyglot"

# An unprivileged user matching the pod securityContext (uid/gid 10001).
RUN groupadd --gid 10001 appgroup \
    && useradd --uid 10001 --gid appgroup --shell /usr/sbin/nologin --no-create-home appuser

WORKDIR /app

# Root-owned and therefore read-only to the app: compiled code (including the
# SQL migrations in dist/) and production dependencies.
COPY --from=build /out ./

USER appuser

ENV NODE_ENV=production \
    PORT=8000

EXPOSE 8000

# Container-level health check hitting the liveness endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["node", "--enable-source-maps", "dist/main.js"]
