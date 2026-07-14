"""
Trains the from-scratch DocumentModel (see model.py) on the dataset built by
prepare_dataset.py: multi-task loss on documentType classification and
invoiceNumber/poNumber BIO tagging, jointly, on one shared encoder.

Genuinely dependency-free of Qwen/QLoRA/Hugging Face Hub: only torch and the
standalone `tokenizers` library are used. No pretrained checkpoint is ever
downloaded — the model starts from random weights.

Usage:
  python3 train.py \\
      --tokenizer ./tokenizer/tokenizer.json \\
      --train-file ./data/train.jsonl \\
      --val-file ./data/val.jsonl \\
      --output-dir ./checkpoints/run1
"""

import argparse
import json
import shutil
from pathlib import Path

import torch
import torch.nn as nn
from torch.optim import AdamW
from torch.optim.lr_scheduler import LambdaLR
from torch.utils.data import DataLoader, Dataset
from tokenizers import Tokenizer

from labels import DOC_TYPES, IGNORE_INDEX, TAGS, decode_span
from model import DocumentModel

# Not imported from local-llm/hardware.py on purpose: this pipeline is meant
# to have zero shared code with the Qwen/QLoRA pipeline, so it can genuinely
# be used with nothing but torch + tokenizers installed. The device-selection
# logic is one line either way.


def select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class JsonlDataset(Dataset):
    def __init__(self, path: Path):
        self.examples = []
        with path.open(encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    self.examples.append(json.loads(line))

    def __len__(self):
        return len(self.examples)

    def __getitem__(self, idx):
        return self.examples[idx]


def make_collate_fn(pad_token_id: int):
    def collate(batch: list[dict]):
        max_len = max(len(ex["input_ids"]) for ex in batch)

        input_ids = torch.full((len(batch), max_len), pad_token_id, dtype=torch.long)
        attention_mask = torch.zeros((len(batch), max_len), dtype=torch.long)
        tag_ids = torch.full((len(batch), max_len), IGNORE_INDEX, dtype=torch.long)
        doc_types = torch.zeros(len(batch), dtype=torch.long)

        for i, ex in enumerate(batch):
            length = len(ex["input_ids"])
            input_ids[i, :length] = torch.tensor(ex["input_ids"], dtype=torch.long)
            attention_mask[i, :length] = 1
            tag_ids[i, :length] = torch.tensor(ex["tag_ids"], dtype=torch.long)
            doc_types[i] = ex["doc_type"]

        return {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "tag_ids": tag_ids,
            "doc_type": doc_types,
        }

    return collate


def linear_warmup_decay_schedule(optimizer, warmup_steps: int, total_steps: int):
    def lr_lambda(step: int) -> float:
        if step < warmup_steps:
            return step / max(1, warmup_steps)
        progress = (step - warmup_steps) / max(1, total_steps - warmup_steps)
        return max(0.0, 1.0 - progress)

    return LambdaLR(optimizer, lr_lambda)


@torch.no_grad()
def evaluate(model, dataloader, device, tokenizer):
    """
    Reports classification accuracy and extraction exact-match rate — the
    metrics that actually matter end-to-end, not just token-level tagging
    loss, which can look fine while every predicted span is off by one token.
    """
    model.eval()
    correct_doc_type = 0
    total = 0
    inv_correct = 0
    inv_total = 0
    po_correct = 0
    po_total = 0

    for batch in dataloader:
        input_ids = batch["input_ids"].to(device)
        attention_mask = batch["attention_mask"].to(device)
        doc_type_logits, tag_logits = model(input_ids, attention_mask)

        pred_doc_types = doc_type_logits.argmax(dim=-1).cpu()
        correct_doc_type += (pred_doc_types == batch["doc_type"]).sum().item()
        total += len(batch["doc_type"])

        pred_tags = tag_logits.argmax(dim=-1).cpu()
        for i in range(len(batch["doc_type"])):
            length = int(batch["attention_mask"][i].sum().item())
            gold_tags = batch["tag_ids"][i, :length].tolist()
            pred_tags_i = pred_tags[i, :length].tolist()

            gold_has_inv = TAGS.index("B-INV") in gold_tags
            gold_has_po = TAGS.index("B-PO") in gold_tags
            if gold_has_inv:
                inv_total += 1
                if pred_tags_i == gold_tags:  # exact tag-sequence match is a strong proxy for exact span match
                    inv_correct += 1
            if gold_has_po:
                po_total += 1
                if pred_tags_i == gold_tags:
                    po_correct += 1

    model.train()
    return {
        "doc_type_accuracy": correct_doc_type / max(1, total),
        "invoiceNumber_exact_match": inv_correct / max(1, inv_total) if inv_total else None,
        "poNumber_exact_match": po_correct / max(1, po_total) if po_total else None,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tokenizer", required=True, type=Path)
    parser.add_argument("--train-file", required=True, type=Path)
    parser.add_argument("--val-file", type=Path, default=None)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--embed-dim", type=int, default=256)
    parser.add_argument("--num-layers", type=int, default=4)
    parser.add_argument("--num-heads", type=int, default=4)
    parser.add_argument("--ff-dim", type=int, default=512)
    parser.add_argument("--max-seq-len", type=int, default=512)
    parser.add_argument("--dropout", type=float, default=0.1)
    parser.add_argument("--tag-loss-weight", type=float, default=1.0)
    parser.add_argument("--warmup-ratio", type=float, default=0.1)
    args = parser.parse_args()

    device = select_device()
    print(f"Device: {device}")
    if device == "cpu":
        print("⚠ No GPU detected — training will be slow, though this model is small enough to still finish in a reasonable time.")

    tokenizer = Tokenizer.from_file(str(args.tokenizer))
    pad_token_id = tokenizer.token_to_id("[PAD]")
    vocab_size = tokenizer.get_vocab_size()

    train_dataset = JsonlDataset(args.train_file)
    val_dataset = JsonlDataset(args.val_file) if args.val_file else None

    collate_fn = make_collate_fn(pad_token_id)
    train_loader = DataLoader(train_dataset, batch_size=args.batch_size, shuffle=True, collate_fn=collate_fn)
    val_loader = (
        DataLoader(val_dataset, batch_size=args.batch_size, shuffle=False, collate_fn=collate_fn)
        if val_dataset
        else None
    )

    model = DocumentModel(
        vocab_size=vocab_size,
        num_doc_types=len(DOC_TYPES),
        num_tags=len(TAGS),
        embed_dim=args.embed_dim,
        num_layers=args.num_layers,
        num_heads=args.num_heads,
        ff_dim=args.ff_dim,
        max_seq_len=args.max_seq_len,
        dropout=args.dropout,
        pad_token_id=pad_token_id,
    ).to(device)

    num_params = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {num_params:,}")

    optimizer = AdamW(model.parameters(), lr=args.lr, weight_decay=0.01)
    total_steps = max(1, len(train_loader) * args.epochs)
    warmup_steps = int(total_steps * args.warmup_ratio)
    scheduler = linear_warmup_decay_schedule(optimizer, warmup_steps, total_steps)

    cls_loss_fn = nn.CrossEntropyLoss()
    tag_loss_fn = nn.CrossEntropyLoss(ignore_index=IGNORE_INDEX)

    model.train()
    for epoch in range(args.epochs):
        epoch_loss = 0.0
        for batch in train_loader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            tag_ids = batch["tag_ids"].to(device)
            doc_type = batch["doc_type"].to(device)

            doc_type_logits, tag_logits = model(input_ids, attention_mask)

            cls_loss = cls_loss_fn(doc_type_logits, doc_type)
            tag_loss = tag_loss_fn(tag_logits.reshape(-1, len(TAGS)), tag_ids.reshape(-1))
            loss = cls_loss + args.tag_loss_weight * tag_loss

            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
            optimizer.step()
            scheduler.step()

            epoch_loss += loss.item()

        avg_loss = epoch_loss / len(train_loader)
        log_line = f"Epoch {epoch + 1}/{args.epochs} — loss: {avg_loss:.4f}"
        if val_loader:
            metrics = evaluate(model, val_loader, device, tokenizer)
            log_line += (
                f" — val doc_type_acc: {metrics['doc_type_accuracy']:.3f}"
                f", val inv_exact: {metrics['invoiceNumber_exact_match']}"
                f", val po_exact: {metrics['poNumber_exact_match']}"
            )
        print(log_line)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.save(model.state_dict(), args.output_dir / "model.pt")
    shutil.copy(args.tokenizer, args.output_dir / "tokenizer.json")

    config = {
        "vocab_size": vocab_size,
        "num_doc_types": len(DOC_TYPES),
        "num_tags": len(TAGS),
        "embed_dim": args.embed_dim,
        "num_layers": args.num_layers,
        "num_heads": args.num_heads,
        "ff_dim": args.ff_dim,
        "max_seq_len": args.max_seq_len,
        "dropout": args.dropout,
        "pad_token_id": pad_token_id,
    }
    (args.output_dir / "config.json").write_text(json.dumps(config, indent=2))

    print(f"\n✅ Model + tokenizer + config saved to {args.output_dir}")
    print(f"   Serve it with: python3 serve.py --model-dir {args.output_dir}")


if __name__ == "__main__":
    main()
