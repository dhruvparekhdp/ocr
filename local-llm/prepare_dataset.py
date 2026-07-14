"""
Merges labeled examples with their extracted PDF text into the JSONL training
format the fine-tuning script consumes.

Inputs:
  --texts-dir   Directory of .txt files produced by
                `node scripts/extract-text.js <pdfDir> <textsDir>` — one file
                per PDF, same basename.
  --labels      A JSONL file, one object per line:
                {"fileName": "<basename, no extension>",
                 "documentType": "PO"|"Invoice"|"AWB_BL"|"Shipping Bill"|"Unknown",
                 "invoiceNumber": "<string>" | null,
                 "poNumber": "<string>" | null}
                See data/labels.template.jsonl for a worked example.

Output:
  --out-dir     Writes train.jsonl and val.jsonl (chat-formatted training
                examples), split by --val-split.

Usage:
  python3 prepare_dataset.py \\
      --texts-dir ./extracted_texts \\
      --labels ./data/labels.jsonl \\
      --out-dir ./data
"""

import argparse
import json
import random
import sys
from pathlib import Path

from prompt import VALID_DOC_TYPES, build_messages


def load_labels(labels_path: Path) -> list[dict]:
    labels = []
    with labels_path.open(encoding="utf-8") as f:
        for line_num, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as e:
                sys.exit(f"✗ {labels_path}:{line_num}: invalid JSON — {e}")
            for field in ("fileName", "documentType", "invoiceNumber", "poNumber"):
                if field not in row:
                    sys.exit(f"✗ {labels_path}:{line_num}: missing required field '{field}'")
            if row["documentType"] not in VALID_DOC_TYPES:
                sys.exit(
                    f"✗ {labels_path}:{line_num}: documentType '{row['documentType']}' "
                    f"is not one of {sorted(VALID_DOC_TYPES)}"
                )
            labels.append(row)
    return labels


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--texts-dir", required=True, type=Path)
    parser.add_argument("--labels", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--val-split", type=float, default=0.1, help="Fraction held out for validation (default 0.1)")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    labels = load_labels(args.labels)
    if not labels:
        sys.exit(f"✗ No labeled examples found in {args.labels}")

    examples = []
    missing = 0
    for row in labels:
        text_path = args.texts_dir / f"{row['fileName']}.txt"
        if not text_path.exists():
            print(f"⚠ Skipping '{row['fileName']}': no matching text file at {text_path}")
            missing += 1
            continue
        document_text = text_path.read_text(encoding="utf-8")
        completion = {
            "documentType": row["documentType"],
            "invoiceNumber": row["invoiceNumber"],
            "poNumber": row["poNumber"],
        }
        examples.append({"messages": build_messages(document_text, completion)})

    if not examples:
        sys.exit("✗ No examples could be built — check --texts-dir matches --labels fileName values.")

    random.Random(args.seed).shuffle(examples)
    val_count = max(1, round(len(examples) * args.val_split)) if len(examples) > 1 else 0
    val_examples = examples[:val_count]
    train_examples = examples[val_count:]

    args.out_dir.mkdir(parents=True, exist_ok=True)
    train_path = args.out_dir / "train.jsonl"
    val_path = args.out_dir / "val.jsonl"

    with train_path.open("w", encoding="utf-8") as f:
        for ex in train_examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    with val_path.open("w", encoding="utf-8") as f:
        for ex in val_examples:
            f.write(json.dumps(ex, ensure_ascii=False) + "\n")

    print(f"✅ Wrote {len(train_examples)} training example(s) to {train_path}")
    print(f"✅ Wrote {len(val_examples)} validation example(s) to {val_path}")
    if missing:
        print(f"⚠ Skipped {missing} label row(s) with no matching text file")
    if len(train_examples) < 50:
        print(
            f"⚠ Only {len(train_examples)} training examples — LoRA fine-tuning can work with "
            "a few hundred, but results below ~50-100 per document type are likely to be shaky. "
            "More labeled data will matter more than any hyperparameter tuning at this stage."
        )


if __name__ == "__main__":
    main()
