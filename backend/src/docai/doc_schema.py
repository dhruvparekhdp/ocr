from enum import StrEnum
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Literal

from pydantic import BaseModel, Field, model_validator

from docai.settings import get_settings


class FieldType(StrEnum):
    STRING = "string"
    ID = "id"
    DATE = "date"
    MONEY = "money"
    NUMBER = "number"
    CURRENCY = "currency"
    TABLE = "table"


class Branding(BaseModel):
    productName: str = "DocuAnalyse"
    primaryColor: str = "#4f8cff"
    logoUrl: str | None = None


class Extractor(StrEnum):
    """Offline (no-LLM) extraction strategies, ported from the legacy Node extractors."""

    LABELED_ID = "labeledId"
    LABELED_TEXT = "labeledText"
    LABELED_ADDRESS = "labeledAddress"
    COMPANY = "company"
    ADDRESS = "address"
    DATE = "date"
    AMOUNT = "amount"
    CURRENCY = "currency"


class DocumentType(BaseModel):
    name: str
    description: str
    # Offline-mode classification: weighted keyword scoring.
    keywords: list[str] = Field(default_factory=list)
    keywordWeight: float = 5


class Column(BaseModel):
    name: str
    type: FieldType

    @model_validator(mode="after")
    def _scalar_only(self) -> "Column":
        if self.type is FieldType.TABLE:
            raise ValueError(f"column {self.name!r}: nested tables are not supported")
        return self


class FieldSpec(BaseModel):
    name: str
    type: FieldType
    description: str
    appliesTo: list[str]
    isBatchKey: bool = False
    columns: list[Column] = Field(default_factory=list)
    # Offline-mode hints; ignored by LLM extraction, which uses name/description/type.
    extractor: Extractor | None = None
    labels: list[str] = Field(default_factory=list)
    # Offline fallback when no label matches (legacy behaviour for the total and the document date).
    fallback: Literal["largestAmount", "firstDate"] | None = None

    @model_validator(mode="after")
    def _columns_match_type(self) -> "FieldSpec":
        if (self.type is FieldType.TABLE) != bool(self.columns):
            raise ValueError(f"field {self.name!r}: 'columns' is required for tables and only for tables")
        return self


class SumRule(BaseModel):
    rule: Literal["sum"]
    fields: list[str]
    equals: str


class SumColumnRule(BaseModel):
    rule: Literal["sumColumn"]
    table: str
    column: str
    equals: str


class NotBeforeRule(BaseModel):
    rule: Literal["notBefore"]
    field: str
    reference: str


class BalanceRule(BaseModel):
    rule: Literal["balance"]
    opening: str
    table: str
    credit: str
    debit: str
    closing: str


ValidationRule = Annotated[SumRule | SumColumnRule | NotBeforeRule | BalanceRule, Field(discriminator="rule")]


class DocSchema(BaseModel):
    version: int
    branding: Branding = Field(default_factory=Branding)
    # How to read ambiguous numeric dates like 01/04/2026; null leaves them unresolved (flagged, not guessed).
    dateOrder: Literal["DMY", "MDY"] | None = None
    documentTypes: list[DocumentType]
    fields: list[FieldSpec]
    # Cross-field checks applied after extraction in every mode (see docai/extract/validate.py).
    validations: list[ValidationRule] = Field(default_factory=list)

    @model_validator(mode="after")
    def _consistent(self) -> "DocSchema":
        type_names = [t.name for t in self.documentTypes]
        if len(set(type_names)) != len(type_names):
            raise ValueError("duplicate document type names")
        field_names = [f.name for f in self.fields]
        if len(set(field_names)) != len(field_names):
            raise ValueError("duplicate field names")
        known = set(type_names)
        for f in self.fields:
            unknown = set(f.appliesTo) - known
            if unknown:
                raise ValueError(f"field {f.name!r} applies to unknown types: {sorted(unknown)}")
        names = set(field_names)
        for rule in self.validations:
            match rule:
                case SumRule():
                    refs = [*rule.fields, rule.equals]
                case SumColumnRule():
                    refs = [rule.table, rule.equals]
                case NotBeforeRule():
                    refs = [rule.field, rule.reference]
                case BalanceRule():
                    refs = [rule.opening, rule.table, rule.closing]
            if missing := set(refs) - names:
                raise ValueError(f"validation {rule.rule!r} references unknown fields: {sorted(missing)}")
        return self

    def field(self, name: str) -> FieldSpec:
        return next(f for f in self.fields if f.name == name)

    def fields_for(self, document_type: str) -> list[FieldSpec]:
        return [f for f in self.fields if document_type in f.appliesTo]


def load_schema(path: Path) -> DocSchema:
    return DocSchema.model_validate_json(path.read_text())


@lru_cache
def get_schema() -> DocSchema:
    return load_schema(get_settings().schema_path)
