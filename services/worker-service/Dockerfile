# syntax=docker/dockerfile:1.7
# Build context MUST be the repository root, so the uv workspace (uv.lock and
# libs/py-shared) is available:
#   docker build -f services/worker-service/Dockerfile -t worker-service:latest .

# ---------- Stage 1: builder ----------------------------------------------
FROM python:3.11-slim-bookworm AS builder

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /bin/uv

# Build tooling needed to compile any C-extension wheels (e.g. Pillow deps).
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc build-essential libjpeg-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# Install into a virtualenv at the same path as in the runtime stage, using
# the image's Python.
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /src

# Third-party dependencies first, from the lockfile and manifests alone, so
# this layer is cached until they change.
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=libs/py-shared/pyproject.toml,target=libs/py-shared/pyproject.toml \
    --mount=type=bind,source=services/worker-service/pyproject.toml,target=services/worker-service/pyproject.toml \
    uv sync --locked --no-dev --package worker-service --no-install-workspace

# Then the worker and the shared library themselves, as regular
# (non-editable) packages: the runtime stage needs only the virtualenv.
COPY pyproject.toml uv.lock ./
COPY libs/py-shared libs/py-shared
COPY services/worker-service services/worker-service
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-dev --package worker-service --no-editable

# ---------- Stage 2: runtime ------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

LABEL org.opencontainers.image.title="saas-docprocessor-worker-service" \
      org.opencontainers.image.description="Text-extraction worker for the SaaS document processing platform" \
      org.opencontainers.image.source="https://example.invalid/saas_docprocessor_polyglot"

# tesseract-ocr is a runtime system dependency required by pytesseract for
# OCR of image uploads (PNG/JPG). libjpeg/zlib runtime libs are needed by Pillow.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tesseract-ocr \
        tesseract-ocr-eng \
        libjpeg62-turbo \
        zlib1g \
        libgl1 \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 appgroup \
    && useradd --uid 10001 --gid appgroup --shell /usr/sbin/nologin --no-create-home appuser

WORKDIR /app

# Root-owned and therefore read-only to the app.
COPY --from=builder /app/.venv /app/.venv

USER appuser

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    METRICS_PORT=9100 \
    HEALTH_PORT=8080

EXPOSE 8080 9100

# Health check: /healthz is served on the worker's own event loop and fails
# when the consumer loop's heartbeat goes stale. (The Prometheus endpoint runs
# in a separate thread, so it would keep answering even if the loop hung.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0) if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).status==200 else sys.exit(1)"

ENTRYPOINT ["worker-service"]
