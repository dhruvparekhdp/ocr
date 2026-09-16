from logging.config import fileConfig

from alembic import context

from docai.db import Base, UTCDateTime, build_engine
from docai.settings import get_settings

if context.config.config_file_name:
    fileConfig(context.config.config_file_name)


def render_item(type_, obj, autogen_context):
    # UTCDateTime only changes Python-side conversion; the column is a plain timezone-aware DateTime.
    if type_ == "type" and isinstance(obj, UTCDateTime):
        return "sa.DateTime(timezone=True)"
    return False


engine = build_engine(get_settings().database_url)

with engine.connect() as connection:
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        render_item=render_item,
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()
