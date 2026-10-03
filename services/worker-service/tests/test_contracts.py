"""The worker's side of the cross-language contracts: it accepts every golden
`document.uploaded` job (as the TypeScript document service produces them)
and publishes completion events that satisfy the shared schema."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from jsonschema import Draft202012Validator

from worker_service import processing

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"


def _examples(kind: str) -> list[Path]:
    return sorted((CONTRACTS / "examples" / "document-uploaded" / kind).glob("*.json"))


@pytest.mark.parametrize("example", _examples("valid"), ids=lambda p: p.name)
def test_worker_accepts_valid_jobs(example: Path) -> None:
    job = processing.parse_job(example.read_text())
    assert job.resolve_blob_name("raw-documents")


@pytest.mark.parametrize("example", _examples("invalid"), ids=lambda p: p.name)
def test_worker_dead_letters_invalid_jobs(example: Path) -> None:
    with pytest.raises(processing.PermanentProcessingError):
        processing.parse_job(example.read_text())


@pytest.mark.parametrize("status", ["succeeded", "failed"])
async def test_published_completion_event_satisfies_the_schema(status: str) -> None:
    sender = MagicMock()
    sender.send_messages = AsyncMock()
    sender.__aenter__ = AsyncMock(return_value=sender)
    sender.__aexit__ = AsyncMock(return_value=None)
    client = MagicMock()
    client.get_topic_sender.return_value = sender

    await processing.publish_completion_event(
        client,
        doc_id="doc-1",
        tenant_id="tenant-1",
        status_value=status,
        result_blob_url="https://acct.blob.core.windows.net/extraction-results/tenant-1/doc-1.json"
        if status == "succeeded"
        else None,
        correlation_id="corr-1",
        error=None if status == "succeeded" else "corrupt file",
    )

    message = sender.send_messages.await_args.args[0]
    schema = json.loads((CONTRACTS / "schemas" / "extraction-completed.schema.json").read_text())
    Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(json.loads(str(message)))
    assert message.message_id == f"doc-1:{status}"
    assert message.application_properties == {"tenant_id": "tenant-1", "doc_id": "doc-1", "status": status}
