import json

import pytest
from pydantic import ValidationError

from docai.doc_schema import DocSchema, get_schema
from docai.settings import get_settings


def _raw() -> dict:
    return json.loads(get_settings().schema_path.read_text())


def test_default_schema_is_valid():
    schema = get_schema()
    assert "lineItems" in [f.name for f in schema.fields_for("Invoice")]
    assert "transactions" in [f.name for f in schema.fields_for("Bank Statement")]
    assert schema.fields_for("Unknown") == []


def test_rejects_unknown_document_type_reference():
    raw = _raw()
    raw["fields"][0]["appliesTo"] = ["Payslip"]
    with pytest.raises(ValidationError, match="unknown types"):
        DocSchema.model_validate(raw)


def test_rejects_table_without_columns_and_columns_on_scalar():
    raw = _raw()
    raw["fields"].append({"name": "rows", "type": "table", "description": "x", "appliesTo": ["Invoice"]})
    with pytest.raises(ValidationError, match="columns"):
        DocSchema.model_validate(raw)

    raw = _raw()
    raw["fields"][0]["columns"] = [{"name": "a", "type": "string"}]
    with pytest.raises(ValidationError, match="columns"):
        DocSchema.model_validate(raw)


def test_rejects_duplicate_field_names():
    raw = _raw()
    raw["fields"].append(raw["fields"][0])
    with pytest.raises(ValidationError, match="duplicate field"):
        DocSchema.model_validate(raw)
