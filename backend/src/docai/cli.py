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

    analyze = sub.add_parser(
        "analyze", help="offline: parse, classify, extract and batch every file in a folder (legacy index.js parity)"
    )
    analyze.add_argument("directory", type=Path)
    analyze.add_argument("--out", type=Path, help="write the JSON report here (default: print it)")
    analyze.add_argument("--schema", type=Path, help="schema JSON (defaults to config/schema.json)")

    parse = sub.add_parser("parse", help="parse a local file and print the result (no database)")
    parse.add_argument("file", type=Path)
    parse.add_argument("--format", choices=["text", "json"], default="text")

    args = parser.parse_args(argv)
    if args.command == "parse":
        return _parse(args.file, args.format)
    if args.command == "analyze":
        return _analyze(args.directory, args.out, args.schema)
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


def _analyze(directory: Path, out: Path | None, schema_path: Path | None) -> int:
    import json
    from datetime import UTC, datetime

    from docai.doc_schema import get_schema
    from docai.extract.batching import BatchItem, segregate
    from docai.extract.heuristic import extract_offline
    from docai.extract.validate import validate
    from docai.ingest import ParseError, parse_file

    schema = load_schema(schema_path) if schema_path else get_schema()
    documents, errors, items = [], [], []
    for path in sorted(p for p in directory.iterdir() if p.is_file() and not p.name.startswith(".")):
        try:
            mime_type, kind = sniff_file(path, path.name)
            parsed = parse_file(path, kind, mime_type, path.name, get_settings().max_pages)
        except (UploadRejected, ParseError) as e:
            errors.append({"file": path.name, "reason": str(e)})
            continue
        extraction = validate(extract_offline(parsed, schema), schema)
        used_ocr = any(page.source != "text" for page in parsed.pages) or any(s.images for s in parsed.sheets)
        documents.append(
            {
                "file": path.name,
                "source": "ocr" if used_ocr else "text",
                "documentType": extraction.document_type,
                "fields": extraction.values(),
                "additionalFields": [a.model_dump() for a in extraction.additional_fields],
                "issues": extraction.issues,
            }
        )
        items.append(BatchItem(path.name, path.name, extraction.document_type, extraction.values()))

    grouping = segregate(items, [f.name for f in schema.fields if f.isBatchKey])
    report = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "sourceDirectory": str(directory),
        "summary": {
            "totalFiles": len(documents) + len(errors),
            "analyzed": len(documents),
            "ocrUsed": sum(d["source"] == "ocr" for d in documents),
            "failed": len(errors),
            "batches": len(grouping["batches"]),
            "unbatched": len(grouping["unbatched"]),
        },
        "batches": grouping["batches"],
        "unbatched": grouping["unbatched"],
        "documents": documents,
        "errors": errors,
    }
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if out:
        out.write_text(text + "\n")
        print(
            f"analyzed {len(documents)} file(s), {len(errors)} error(s), {len(grouping['batches'])} batch(es) -> {out}"
        )
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
