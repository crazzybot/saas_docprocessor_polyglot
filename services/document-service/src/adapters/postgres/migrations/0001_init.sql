-- Document catalog + transactional outbox.

CREATE TABLE documents (
    id                  uuid        PRIMARY KEY,
    tenant_id           text        NOT NULL,
    filename            text        NOT NULL,
    content_type        text        NOT NULL,
    size_bytes          bigint      NOT NULL,
    status              text        NOT NULL CHECK (status IN ('queued', 'succeeded', 'failed')),
    error               text,
    raw_blob_container  text        NOT NULL,
    raw_blob_name       text        NOT NULL,
    text_blob_container text,
    text_blob_name      text,
    title               text,
    tags                text[]      NOT NULL DEFAULT '{}',
    metadata            jsonb       NOT NULL DEFAULT '{}',
    version             integer     NOT NULL DEFAULT 1,
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    extracted_at        timestamptz,
    -- Tombstone: set on delete; the row is purged after the retention period
    -- once its blobs have been removed (blobs_deleted).
    deleted_at          timestamptz,
    blobs_deleted       boolean     NOT NULL DEFAULT false
);

-- Newest-first keyset pagination per tenant, optionally filtered by status.
CREATE INDEX documents_tenant_created_idx
    ON documents (tenant_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX documents_tenant_status_created_idx
    ON documents (tenant_id, status, created_at DESC, id DESC) WHERE deleted_at IS NULL;
-- Maintenance: tombstones awaiting blob cleanup / purge.
CREATE INDEX documents_tombstones_idx
    ON documents (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE outbox (
    id           bigserial   PRIMARY KEY,
    message_id   text        NOT NULL,
    event_type   text        NOT NULL,
    body         jsonb       NOT NULL,
    properties   jsonb       NOT NULL DEFAULT '{}',
    created_at   timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX outbox_published_idx ON outbox (published_at) WHERE published_at IS NOT NULL;
