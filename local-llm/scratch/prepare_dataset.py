"""
Builds the from-scratch model's training data: tokenizes each labeled
document with the tokenizer trained by train_tokenizer.py, and converts the
labels into (documentType class id, per-token BIO tag ids) — see labels.py
for how identifier strings become tags.

Inputs (same shape as the LoRA pipeline's prepare_dataset.py):
  --texts-dir   Directory of .txt files (e.g. from scripts/extract-text.js).
  --labels      JSONL: {"fileName", "documentType", "invoiceNumber", "poNumber"}.
  --tokenizer   Path to tokenizer.json from train_tokenizer.py.

Usage:
  python3 prepare_dataset.py \\
      --texts-dir ../data/texts \\
      --labels ../data/labels.jsonl \\
      --tokenizer ./tokenizer/tokenizer.json \\
      --out-dir ./data
"""

import argparse
import json
import random
import sys
from pathlib import Path

from tokenizers import Tokenizer

from labels import DOC_TYPES, TAG_TO_ID, find_span_tags

MAX_SEQ_LEN = 512


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
            if row["documentType"] not in DOC_TYPES:
                sys.exit(f"✗ {labels_path}:{line_num}: documentType '{row['documentType']}' not in {DOC_TYPES}")
            labels.append(row)
    return labels


def build_example(tokenizer: Tokenizer, text: str, row: dict) -> tuple[dict, dict]:
    """
    Returns (example, miss_report). miss_report notes whether invoiceNumber
    / poNumber were labeled but not found verbatim in the text — those
    fields still train documentType but contribute no tagging signal for
    the missing identifier, and a high miss rate here means labels don't
    match the extracted text closely enough (whitespace differences, a
    different PDF extraction than scripts/extract-text.js, OCR artifacts).
    """
    encoding = tokenizer.encode(text)
    input_ids = encoding.ids[:MAX_SEQ_LEN]
    offsets = encoding.offsets[:MAX_SEQ_LEN]

    inv_tags = find_span_tags(text, offsets, row["invoiceNumber"], "INV")
    po_tags = find_span_tags(text, offsets, row["poNumber"], "PO")

    tag_ids = []
    for inv_tag, po_tag in zip(inv_tags, po_tags):
        if inv_tag != "O":
            tag_ids.append(TAG_TO_ID[inv_tag])
        elif po_tag != "O":
            tag_ids.append(TAG_TO_ID[po_tag])
        else:
            tag_ids.append(TAG_TO_ID["O"])

    example = {
        "input_ids": input_ids,
        "tag_ids": tag_ids,
        "doc_type": DOC_TYPES.index(row["documentType"]),
    }
    miss_report = {
        "invoiceNumber_missed": bool(row["invoiceNumber"]) and "B-INV" not in inv_tags,
        "poNumber_missed": bool(row["poNumber"]) and "B-PO" not in po_tags,
    }
    return example, miss_report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--texts-dir", required=True, type=Path)
    parser.add_argument("--labels", required=True, type=Path)
    parser.add_argument("--tokenizer", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--val-split", type=float, default=0.1)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    tokenizer = Tokenizer.from_file(str(args.tokenizer))
    labels = load_labels(args.labels)
    if not labels:
        sys.exit(f"✗ No labeled examples found in {args.labels}")

    examples = []
    missing_text = 0
    inv_missed = 0
    po_missed = 0
    for row in labels:
        text_path = args.texts_dir / f"{row['fileName']}.txt"
        if not text_path.exists():
            print(f"⚠ Skipping '{row['fileName']}': no matching text file at {text_path}")
            missing_text += 1
            continue
        text = text_path.read_text(encoding="utf-8")
        example, miss_report = build_example(tokenizer, text, row)
        examples.append(example)
        if miss_report["invoiceNumber_missed"]:
            inv_missed += 1
            print(f"⚠ '{row['fileName']}': invoiceNumber {row['invoiceNumber']!r} not found verbatim in extracted text")
        if miss_report["poNumber_missed"]:
            po_missed += 1
            print(f"⚠ '{row['fileName']}': poNumber {row['poNumber']!r} not found verbatim in extracted text")

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
            f.write(json.dumps(ex) + "\n")
    with val_path.open("w", encoding="utf-8") as f:
        for ex in val_examples:
            f.write(json.dumps(ex) + "\n")

    print(f"\n✅ Wrote {len(train_examples)} training example(s) to {train_path}")
    print(f"✅ Wrote {len(val_examples)} validation example(s) to {val_path}")
    if missing_text:
        print(f"⚠ Skipped {missing_text} label row(s) with no matching text file")
    if inv_missed or po_missed:
        print(
            f"⚠ {inv_missed} invoiceNumber label(s) and {po_missed} poNumber label(s) could not be "
            "located verbatim in their document's extracted text — those examples still train "
            "documentType, but contribute no extraction signal for the missing field. If this "
            "count is high, double-check labels were transcribed from the exact extracted .txt "
            "files (via scripts/extract-text.js), not from the original PDF's visual layout."
        )
    if len(train_examples) < 200:
        print(
            f"⚠ Only {len(train_examples)} training examples. Training documentType + span "
            "extraction from scratch (no pretrained head start) typically wants low thousands of "
            "examples spread across all document types to generalise well — more data will matter "
            "more than any hyperparameter tuning at this stage."
        )


if __name__ == "__main__":
    main()
