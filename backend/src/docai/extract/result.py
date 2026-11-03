from typing import Any, Literal

from pydantic import BaseModel, Field

Method = Literal["heuristic", "llm", "hybrid"]


class FieldValue(BaseModel):
    """One extracted field. `value` follows the label conventions (ISO dates, plain decimals, ISO currency)."""

    value: Any = None
    raw: str | None = None  # as printed in the document
    line_id: str | None = None  # grounding: which parsed line the value came from
    confidence: float = 0.0
    method: Method = "heuristic"


class AdditionalField(BaseModel):
    """A labelled value the document shows that the schema has no field for, kept under the document's own label."""

    label: str
    value: str
    line_id: str | None = None


class Extraction(BaseModel):
    document_type: str
    type_confidence: float = 0.0
    fields: dict[str, FieldValue] = Field(default_factory=dict)
    additional_fields: list[AdditionalField] = Field(default_factory=list)
    issues: list[str] = Field(default_factory=list)
    mode: Literal["offline", "llm", "hybrid"] = "offline"
    model: str | None = None

    def values(self) -> dict[str, Any]:
        """Plain {field: value} in the eval label format."""
        return {name: fv.value for name, fv in self.fields.items()}
