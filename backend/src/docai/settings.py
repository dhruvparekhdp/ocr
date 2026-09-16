from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=REPO_ROOT / ".env", extra="ignore")

    database_url: str = f"sqlite:///{REPO_ROOT / 'data' / 'docai.db'}"
    storage_dir: Path = REPO_ROOT / "data" / "files"
    schema_path: Path = REPO_ROOT / "config" / "schema.json"
    max_upload_mb: int = 50
    groq_api_key: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
