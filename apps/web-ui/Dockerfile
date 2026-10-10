# syntax=docker/dockerfile:1.7
# Build context MUST be the repository root, so the workspace lockfile and the
# generated API types are available:
#   docker build -f apps/web-ui/Dockerfile -t web-ui:latest .

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

COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@docprocessor/web-ui..." \
    && pnpm --filter @docprocessor/web-ui run build

# ---------- Stage 2: runtime ------------------------------------------------
# Static files only; nginx runs as its unprivileged user (uid 101) on :8080.
FROM nginxinc/nginx-unprivileged:stable-alpine AS runtime

LABEL org.opencontainers.image.title="saas-docprocessor-web-ui" \
      org.opencontainers.image.description="Test client for the SaaS document processing pipeline" \
      org.opencontainers.image.source="https://example.invalid/saas_docprocessor_polyglot"

COPY apps/web-ui/nginx/default.conf /etc/nginx/conf.d/default.conf
# The bundle, including a local-mode config.json; environments mount their own.
COPY --from=build /repo/apps/web-ui/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
