"""The Python contract layer against the golden messages in contracts/examples.

The TypeScript tests run the same examples through Ajv and the generated
types, so both languages agree on what is valid. Each example must get the
same verdict from the JSON Schema itself and from the pydantic models.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator
from pydantic import BaseModel, ValidationError

from docprocessor_shared.contracts import DocumentUploadedEvent, ExtractionCompletedEvent
from docprocessor_shared.generated import document_uploaded_schema, extraction_completed_schema

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
MODELS: dict[str, type[BaseModel]] = {
    "document-uploaded": DocumentUploadedEvent,
    "extraction-completed": ExtractionCompletedEvent,
}


def _schema(contract: str) -> Draft202012Validator:
    schema = json.loads((CONTRACTS / "schemas" / f"{contract}.schema.json").read_text())
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def _examples(kind: str) -> list[tuple[str, str]]:
    return [
        (contract, str(path.relative_to(CONTRACTS)))
        for contract in MODELS
        for path in sorted((CONTRACTS / "examples" / contract / kind).glob("*.json"))
    ]


@pytest.mark.parametrize(("contract", "example"), _examples("valid"))
def test_valid_examples_pass_schema_and_model(contract: str, example: str) -> None:
    body = (CONTRACTS / example).read_text()
    _schema(contract).validate(json.loads(body))
    MODELS[contract].model_validate_json(body)


@pytest.mark.parametrize(("contract", "example"), _examples("invalid"))
def test_invalid_examples_fail_schema_and_model(contract: str, example: str) -> None:
    body = (CONTRACTS / example).read_text()
    assert not _schema(contract).is_valid(json.loads(body))
    with pytest.raises(ValidationError):
        MODELS[contract].model_validate_json(body)


@pytest.mark.parametrize(
    ("contract", "generated"),
    [
        ("document-uploaded", document_uploaded_schema.DocumentUploadedEvent),
        ("extraction-completed", extraction_completed_schema.ExtractionCompletedEvent),
    ],
)
def test_generated_models_match_the_schemas(contract: str, generated: type[BaseModel]) -> None:
    """Catches a schema edited without `just contracts` (CI also diffs the output)."""
    schema = json.loads((CONTRACTS / "schemas" / f"{contract}.schema.json").read_text())
    assert set(generated.model_fields) == set(schema["properties"])


def test_missing_completed_at_means_now() -> None:
    event = ExtractionCompletedEvent.model_validate({"doc_id": "d", "tenant_id": "t", "status": "failed"})
    assert event.completed_at.tzinfo is not None
    assert event.message_id == "d:failed"
