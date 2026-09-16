from enum import StrEnum
from functools import lru_cache
from pathlib import Path

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


class DocumentType(BaseModel):
    name: str
    description: str


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

    @model_validator(mode="after")
    def _columns_match_type(self) -> "FieldSpec":
        if (self.type is FieldType.TABLE) != bool(self.columns):
            raise ValueError(f"field {self.name!r}: 'columns' is required for tables and only for tables")
        return self


class DocSchema(BaseModel):
    version: int
    branding: Branding = Field(default_factory=Branding)
    documentTypes: list[DocumentType]
    fields: list[FieldSpec]

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
        return self

    def fields_for(self, document_type: str) -> list[FieldSpec]:
        return [f for f in self.fields if document_type in f.appliesTo]


def load_schema(path: Path) -> DocSchema:
    return DocSchema.model_validate_json(path.read_text())


@lru_cache
def get_schema() -> DocSchema:
    return load_schema(get_settings().schema_path)
