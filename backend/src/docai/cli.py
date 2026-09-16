import argparse
import sys
from pathlib import Path

from sqlalchemy import select

from docai.db import Tenant, get_sessionmaker
from docai.doc_schema import load_schema
from docai.settings import get_settings
from docai.storage import UploadRejected, sniff_file
from docai.tenants import create_tenant, rotate_api_key


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="docai-admin")
    sub = parser.add_subparsers(dest="command", required=True)

    create = sub.add_parser("create-tenant", help="create a tenant and print its API key")
    create.add_argument("slug")
    create.add_argument("name")
    create.add_argument("--schema", type=Path, help="tenant-specific schema JSON (defaults to config/schema.json)")

    sub.add_parser("list-tenants")

    rotate = sub.add_parser("rotate-key", help="issue a new API key, invalidating the old one")
    rotate.add_argument("slug")

    parse = sub.add_parser("parse", help="parse a local file and print the result (no database)")
    parse.add_argument("file", type=Path)
    parse.add_argument("--format", choices=["text", "json"], default="text")

    args = parser.parse_args(argv)
    if args.command == "parse":
        return _parse(args.file, args.format)
    with get_sessionmaker()() as session:
        if args.command == "create-tenant":
            schema = load_schema(args.schema) if args.schema else None
            tenant, key = create_tenant(session, args.slug, args.name, schema)
            print(f"created tenant {tenant.slug} ({tenant.id})")
            print(f"API key (shown once): {key}")
        elif args.command == "list-tenants":
            for t in session.scalars(select(Tenant).order_by(Tenant.created_at)):
                print(f"{t.slug}\t{t.name}\t{'custom' if t.schema_json else 'default'} schema\t{t.created_at:%Y-%m-%d}")
        elif args.command == "rotate-key":
            tenant = session.scalar(select(Tenant).where(Tenant.slug == args.slug))
            if tenant is None:
                print(f"no tenant {args.slug!r}", file=sys.stderr)
                return 1
            print(f"new API key (shown once): {rotate_api_key(session, tenant)}")
    return 0


def _parse(path: Path, fmt: str) -> int:
    from docai.ingest import ParseError, parse_file

    try:
        mime_type, kind = sniff_file(path, path.name)
        parsed = parse_file(path, kind, mime_type, path.name, get_settings().max_pages)
    except (UploadRejected, ParseError) as e:
        print(e, file=sys.stderr)
        return 1
    print(parsed.to_text() if fmt == "text" else parsed.model_dump_json(indent=2))
    for warning in parsed.warnings:
        print(f"warning: {warning}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
