"""
Local inference server for the fine-tuned classifier. Loads the base model
plus your LoRA adapter and exposes a single endpoint that mirrors the shape
of the Claude-based classifier (llmClassifier.js), so the Node app can point
at either one interchangeably.

Usage:
  python3 serve.py --base-model Qwen/Qwen2.5-0.5B-Instruct --adapter ./checkpoints/run1 --port 8008

Endpoint:
  POST /classify   { "text": "<raw PDF text>" }
                 -> { "documentType": "...", "invoiceNumber": "..."|null, "poNumber": "..."|null }
"""

import argparse
import json
import re

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from peft import PeftModel
from pydantic import BaseModel
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

from hardware import select_device, select_dtype
from prompt import VALID_DOC_TYPES, build_messages

app = FastAPI(title="Local PDF Classifier")

# Populated by main() before uvicorn starts serving requests.
model = None
tokenizer = None
device = "cpu"


class ClassifyRequest(BaseModel):
    text: str


class ClassifyResponse(BaseModel):
    documentType: str
    invoiceNumber: str | None
    poNumber: str | None


def extract_json_object(raw: str) -> dict:
    """
    The model is trained to emit only a JSON object, but generation can still
    add stray whitespace/newlines around it (or, rarely, wrap it in prose).
    Pull out the first {...} span rather than assuming raw.strip() is valid
    JSON outright.
    """
    match = re.search(r"\{.*\}", raw, re.DOTALL)
    if not match:
        raise ValueError(f"no JSON object found in model output: {raw!r}")
    return json.loads(match.group(0))


def run_classification(text: str) -> dict:
    messages = build_messages(text)
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(prompt_text, return_tensors="pt", add_special_tokens=False).to(device)

    with torch.no_grad():
        output_ids = model.generate(
            **inputs,
            max_new_tokens=128,
            do_sample=False,  # greedy — deterministic, and this task has one right answer
            pad_token_id=tokenizer.pad_token_id or tokenizer.eos_token_id,
        )

    generated = output_ids[0][inputs["input_ids"].shape[1] :]
    raw_output = tokenizer.decode(generated, skip_special_tokens=True)

    parsed = extract_json_object(raw_output)

    doc_type = parsed.get("documentType")
    if doc_type not in VALID_DOC_TYPES:
        raise ValueError(f"model returned an invalid documentType: {doc_type!r}")

    return {
        "documentType": doc_type,
        "invoiceNumber": parsed.get("invoiceNumber"),
        "poNumber": parsed.get("poNumber"),
    }


@app.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest):
    try:
        return run_classification(req.text)
    except (ValueError, json.JSONDecodeError) as e:
        raise HTTPException(status_code=502, detail=f"Model output could not be parsed: {e}")


@app.get("/health")
def health():
    return {"status": "ok"}


def main():
    global model, tokenizer, device

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-model", default="Qwen/Qwen2.5-0.5B-Instruct")
    parser.add_argument("--adapter", required=True, help="Path to the LoRA adapter directory saved by train.py")
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument(
        "--load-in-4bit",
        action="store_true",
        help="Load the base model in 4-bit. Pass this if you trained with --load-in-4bit; requires a CUDA GPU.",
    )
    args = parser.parse_args()

    device = select_device()
    dtype = select_dtype(device)
    print(f"Device: {device}, dtype: {dtype}")
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

    base_model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        dtype=dtype if quant_config is None else None,
        quantization_config=quant_config,
        device_map={"": 0} if quant_config is not None else None,
    )
    model = PeftModel.from_pretrained(base_model, args.adapter)
    if quant_config is None:
        model.to(device)
    model.eval()

    print(f"✅ Loaded {args.base_model} + adapter from {args.adapter}")
    print(f"   Point the Node app at this server: LOCAL_LLM_URL=http://{args.host}:{args.port} CLASSIFIER=local")

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
