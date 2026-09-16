from logging.config import fileConfig

from alembic import context

from docai.db import Base, build_engine
from docai.settings import get_settings

if context.config.config_file_name:
    fileConfig(context.config.config_file_name)

engine = build_engine(get_settings().database_url)

with engine.connect() as connection:
    context.configure(
        connection=connection,
        target_metadata=Base.metadata,
        render_as_batch=connection.dialect.name == "sqlite",
    )
    with context.begin_transaction():
        context.run_migrations()
