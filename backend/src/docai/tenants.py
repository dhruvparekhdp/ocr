import hashlib
import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from docai.db import Tenant
from docai.doc_schema import DocSchema, get_schema

API_KEY_PREFIX = "dak_"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,62}$")


def hash_api_key(api_key: str) -> str:
    return hashlib.sha256(api_key.encode()).hexdigest()


def new_api_key() -> str:
    return API_KEY_PREFIX + secrets.token_urlsafe(32)


def create_tenant(session: Session, slug: str, name: str, schema: DocSchema | None = None) -> tuple[Tenant, str]:
    """Returns the tenant and its plaintext API key, which is not stored and cannot be recovered."""
    if not SLUG_RE.match(slug):
        raise ValueError("slug must be 2-63 chars of lowercase letters, digits and hyphens")
    api_key = new_api_key()
    tenant = Tenant(
        slug=slug,
        name=name,
        api_key_hash=hash_api_key(api_key),
        schema_json=schema.model_dump_json() if schema else None,
    )
    session.add(tenant)
    session.commit()
    return tenant, api_key


def rotate_api_key(session: Session, tenant: Tenant) -> str:
    api_key = new_api_key()
    tenant.api_key_hash = hash_api_key(api_key)
    session.commit()
    return api_key


def find_by_api_key(session: Session, api_key: str) -> Tenant | None:
    return session.scalar(select(Tenant).where(Tenant.api_key_hash == hash_api_key(api_key)))


def tenant_schema(tenant: Tenant) -> DocSchema:
    if tenant.schema_json:
        return DocSchema.model_validate_json(tenant.schema_json)
    return get_schema()
