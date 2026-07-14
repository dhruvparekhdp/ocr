"""
Local inference server for the from-scratch model. Loads the trained
weights, config, and tokenizer from a checkpoint directory (all three saved
together by train.py) and exposes the exact same endpoint contract as the
Qwen/QLoRA pipeline's serve.py, so the Node app's CLASSIFIER=local wiring
and localClassifier.js work unchanged regardless of which pipeline trained
the model actually being served.

Usage:
  python3 serve.py --model-dir ./checkpoints/run1 --port 8008

Endpoint:
  POST /classify   { "text": "<raw PDF text>" }
                 -> { "documentType": "...", "invoiceNumber": "..."|null, "poNumber": "..."|null }
"""

import argparse
import json
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from tokenizers import Tokenizer

from labels import DOC_TYPES, decode_span
from model import DocumentModel

app = FastAPI(title="From-Scratch Local PDF Classifier")

# Populated by main() before uvicorn starts serving requests.
model = None
tokenizer = None
device = "cpu"
max_seq_len = 512


class ClassifyRequest(BaseModel):
    text: str


class ClassifyResponse(BaseModel):
    documentType: str
    invoiceNumber: str | None
    poNumber: str | None


def select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def run_classification(text: str) -> dict:
    encoding = tokenizer.encode(text)
    input_ids = encoding.ids[:max_seq_len]
    offsets = encoding.offsets[:max_seq_len]

    input_tensor = torch.tensor([input_ids], dtype=torch.long, device=device)
    attention_mask = torch.ones_like(input_tensor)

    with torch.no_grad():
        doc_type_logits, tag_logits = model(input_tensor, attention_mask)

    doc_type_id = doc_type_logits.argmax(dim=-1).item()
    doc_type = DOC_TYPES[doc_type_id]

    tag_ids = tag_logits.argmax(dim=-1)[0].cpu().tolist()

    invoice_number = decode_span(text, offsets, tag_ids, "INV")
    po_number = decode_span(text, offsets, tag_ids, "PO")

    # Mirror the app's own convention: POs never carry an invoice number,
    # and only PO/Invoice documents carry a PO reference — see analyzeText()
    # in index.js. Enforcing it here keeps behavior consistent even if the
    # tagging head predicts a spurious span on the wrong document type.
    if doc_type == "PO":
        invoice_number = None
    if doc_type not in ("PO", "Invoice"):
        po_number = None

    return {
        "documentType": doc_type,
        "invoiceNumber": invoice_number,
        "poNumber": po_number,
    }


@app.post("/classify", response_model=ClassifyResponse)
def classify(req: ClassifyRequest):
    try:
        return run_classification(req.text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Classification failed: {e}")


@app.get("/health")
def health():
    return {"status": "ok"}


def main():
    global model, tokenizer, device, max_seq_len

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model-dir", required=True, type=Path, help="Checkpoint directory saved by train.py (model.pt, config.json, tokenizer.json)")
    parser.add_argument("--port", type=int, default=8008)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    device = select_device()
    print(f"Device: {device}")

    config = json.loads((args.model_dir / "config.json").read_text())
    max_seq_len = config["max_seq_len"]

    tokenizer = Tokenizer.from_file(str(args.model_dir / "tokenizer.json"))

    model = DocumentModel(
        vocab_size=config["vocab_size"],
        num_doc_types=config["num_doc_types"],
        num_tags=config["num_tags"],
        embed_dim=config["embed_dim"],
        num_layers=config["num_layers"],
        num_heads=config["num_heads"],
        ff_dim=config["ff_dim"],
        max_seq_len=config["max_seq_len"],
        dropout=config["dropout"],
        pad_token_id=config["pad_token_id"],
    )
    model.load_state_dict(torch.load(args.model_dir / "model.pt", map_location=device))
    model.to(device)
    model.eval()

    print(f"✅ Loaded from-scratch model from {args.model_dir}")
    print(f"   Point the Node app at this server: LOCAL_LLM_URL=http://{args.host}:{args.port} CLASSIFIER=local")

    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
