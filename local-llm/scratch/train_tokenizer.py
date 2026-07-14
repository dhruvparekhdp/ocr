"""
Trains a byte-level BPE tokenizer from scratch on your own document text —
no Qwen vocab, no pretrained tokenizer of any kind. Uses the standalone
`tokenizers` library only (not `transformers`), so this pipeline has zero
dependency on Hugging Face Hub model downloads.

A small vocab (8k-16k) is plenty for a narrow document-classification
domain — you don't need general-English/code coverage the way a 150k-token
LLM vocab does.

Usage:
  python3 train_tokenizer.py --texts-dir ../data/texts --vocab-size 8000 --output-dir ./tokenizer
"""

import argparse
from pathlib import Path

from tokenizers import ByteLevelBPETokenizer

SPECIAL_TOKENS = ["[PAD]", "[UNK]"]


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--texts-dir", required=True, type=Path, help="Directory of .txt files (e.g. from scripts/extract-text.js)")
    parser.add_argument("--vocab-size", type=int, default=8000)
    parser.add_argument("--min-frequency", type=int, default=2)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    text_files = sorted(str(p) for p in args.texts_dir.glob("*.txt"))
    if not text_files:
        raise SystemExit(f"✗ No .txt files found in {args.texts_dir}")

    print(f"Training on {len(text_files)} file(s)...")

    tokenizer = ByteLevelBPETokenizer()
    tokenizer.train(
        files=text_files,
        vocab_size=args.vocab_size,
        min_frequency=args.min_frequency,
        special_tokens=SPECIAL_TOKENS,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    tokenizer.save(str(args.output_dir / "tokenizer.json"))

    actual_vocab_size = tokenizer.get_vocab_size()
    print(f"✅ Tokenizer saved to {args.output_dir / 'tokenizer.json'} (vocab size: {actual_vocab_size})")
    if actual_vocab_size < args.vocab_size:
        print(
            f"   Note: requested {args.vocab_size} but only {actual_vocab_size} merges were learned — "
            "your corpus may be small/repetitive relative to the requested vocab size. This is fine; "
            "a smaller learned vocab isn't a problem by itself."
        )


if __name__ == "__main__":
    main()
