"""
LoRA fine-tunes a small local instruct model on the labeled document dataset
produced by prepare_dataset.py.

Why LoRA: it trains a small set of low-rank adapter weights instead of the
full model, so it's feasible on modest hardware (a single consumer GPU, or
slowly on CPU) and produces a few-MB adapter file rather than a full model
copy. The base model's weights are downloaded once from Hugging Face and
never modified.

Usage:
  python3 train.py \\
      --base-model Qwen/Qwen2.5-0.5B-Instruct \\
      --train-file ./data/train.jsonl \\
      --val-file ./data/val.jsonl \\
      --output-dir ./checkpoints/run1

Requires internet access on first run (to download the base model from
Hugging Face); fully offline afterward, since the weights are cached locally.
"""

import argparse
import json
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
    DataCollatorForSeq2Seq,
    Trainer,
    TrainingArguments,
)

from hardware import select_device, select_dtype

# Standard attention + MLP projection names for the Qwen2 / Llama-family
# architectures used by the small instruct models this script targets. If you
# swap in a different architecture, check its config for the equivalent
# module names.
DEFAULT_LORA_TARGET_MODULES = [
    "q_proj", "k_proj", "v_proj", "o_proj",
    "gate_proj", "up_proj", "down_proj",
]


def build_tokenize_fn(tokenizer, max_length: int):
    """
    Renders each example's chat messages through the model's own chat
    template, tokenizes it, and masks every token before the assistant's
    reply with -100 so the loss is computed only on the JSON completion —
    not on the system prompt or the document text, which would otherwise
    dominate the loss and teach the model nothing useful.
    """

    def tokenize(example):
        messages = example["messages"]
        assistant_content = messages[-1]["content"]
        prompt_messages = messages[:-1]

        prompt_text = tokenizer.apply_chat_template(
            prompt_messages, tokenize=False, add_generation_prompt=True
        )
        full_text = tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )

        prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
        full_ids = tokenizer(
            full_text, add_special_tokens=False, truncation=True, max_length=max_length
        )["input_ids"]

        labels = list(full_ids)
        mask_len = min(len(prompt_ids), len(labels))
        for i in range(mask_len):
            labels[i] = -100

        return {"input_ids": full_ids, "labels": labels}

    return tokenize


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--train-file", required=True, type=Path)
    parser.add_argument("--val-file", type=Path, default=None)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--epochs", type=float, default=3.0)
    parser.add_argument("--lr", type=float, default=2e-4)
    parser.add_argument("--lora-r", type=int, default=16)
    parser.add_argument("--lora-alpha", type=int, default=32)
    parser.add_argument("--max-length", type=int, default=4096)
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--grad-accum", type=int, default=8)
    parser.add_argument(
        "--load-in-4bit",
        action="store_true",
        help=(
            "Load the base model in 4-bit (QLoRA) instead of fp16/bf16. Lets a larger "
            "base model (e.g. 1.5B-3B) fit on a small GPU (~4GB VRAM) at the cost of "
            "some training speed. Requires the `bitsandbytes` package."
        ),
    )
    parser.add_argument(
        "--no-gradient-checkpointing",
        action="store_true",
        help="Disable gradient checkpointing (on by default). Only turn this off if you have VRAM to spare — it trades some speed for a large drop in memory use.",
    )
    args = parser.parse_args()

    device = select_device()
    dtype = select_dtype(device)
    print(f"Device: {device}, dtype: {dtype}")
    if device == "cpu":
        print(
            "⚠ No GPU detected — training will be slow. This still works for a small "
            "model + LoRA + a modest dataset, just budget more time (hours, not minutes)."
        )
    if args.load_in_4bit and device != "cuda":
        parser.error("--load-in-4bit requires a CUDA GPU (bitsandbytes has no CPU/MPS kernel).")

    tokenizer = AutoTokenizer.from_pretrained(args.base_model)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    quant_config = None
    if args.load_in_4bit:
        quant_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=dtype,
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        dtype=dtype if quant_config is None else None,
        quantization_config=quant_config,
        device_map={"": 0} if quant_config is not None else None,
    )
    if quant_config is not None:
        model = prepare_model_for_kbit_training(
            model, use_gradient_checkpointing=not args.no_gradient_checkpointing
        )
    else:
        model.to(device)

    lora_config = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        target_modules=DEFAULT_LORA_TARGET_MODULES,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    if not args.no_gradient_checkpointing:
        # Required alongside LoRA: only the adapter weights require grad, so
        # checkpointing needs this to keep gradients flowing back through the
        # frozen base model's input embeddings during the backward recompute.
        model.enable_input_require_grads()

    data_files = {"train": str(args.train_file)}
    if args.val_file:
        data_files["validation"] = str(args.val_file)
    dataset = load_dataset("json", data_files=data_files)

    tokenize_fn = build_tokenize_fn(tokenizer, args.max_length)
    tokenized = dataset.map(tokenize_fn, remove_columns=dataset["train"].column_names)

    collator = DataCollatorForSeq2Seq(tokenizer, model=model, padding=True, label_pad_token_id=-100)

    training_args = TrainingArguments(
        output_dir=str(args.output_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        logging_steps=5,
        save_strategy="epoch",
        eval_strategy="epoch" if args.val_file else "no",
        bf16=dtype == torch.bfloat16,
        fp16=dtype == torch.float16,
        gradient_checkpointing=not args.no_gradient_checkpointing,
        report_to=[],
    )

    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=tokenized["train"],
        eval_dataset=tokenized.get("validation"),
        data_collator=collator,
    )

    trainer.train()

    model.save_pretrained(str(args.output_dir))
    tokenizer.save_pretrained(str(args.output_dir))

    metadata = {"base_model": args.base_model}
    (args.output_dir / "adapter_metadata.json").write_text(json.dumps(metadata, indent=2))

    print(f"✅ Adapter saved to {args.output_dir}")
    print(f"   Serve it with: python3 serve.py --base-model {args.base_model} --adapter {args.output_dir}")


if __name__ == "__main__":
    main()
