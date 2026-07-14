"""
Shared prompt construction for the local classifier — used by both
prepare_dataset.py (building training examples) and serve.py (building
inference requests). Keeping this in one place guarantees the model sees the
exact same instruction format at training and inference time; any drift
between the two silently degrades accuracy.
"""

import json

VALID_DOC_TYPES = {"PO", "Invoice", "AWB_BL", "Shipping Bill", "Unknown"}

SYSTEM_PROMPT = """You classify trade/shipping documents and extract two identifiers. Respond with ONLY a JSON object, no other text.

Document types:
- PO: purchase orders, and documents that functionally serve as the purchase anchor even under a different name (e.g. a Proforma Invoice or Packing List that an Invoice's PO/reference field points back to).
- Invoice: commercial invoices, tax invoices, any billing document from seller to buyer.
- AWB_BL: air waybills and bills of lading (including sea waybills) - transport/carrier documents.
- Shipping Bill: customs export declarations (shipping bill / EDI printouts / "LET EXPORT COPY" style documents).
- Unknown: anything that doesn't fit, or has no recognisable business-document identity.

Identifier rules:
- invoiceNumber: the invoice/commercial-reference number tying an Invoice, AWB_BL, and Shipping Bill together for one shipment. PO documents never have one - always null.
- poNumber: the purchase-order/proforma/reference number tying a PO-type document to the Invoice that references it. AWB_BL and Shipping Bill typically don't carry one - null unless clearly present.
- Return identifiers exactly as printed. If genuinely absent, return null rather than guessing.

Respond with exactly this JSON shape: {"documentType": "...", "invoiceNumber": "..." or null, "poNumber": "..." or null}"""

# Documents longer than this are truncated (head + tail) before the prompt —
# mirrors llmClassifier.js's truncateForPrompt so local and Claude-based
# classification see comparably-sized input.
MAX_INPUT_CHARS = 12000


def truncate_for_prompt(text: str) -> str:
    if len(text) <= MAX_INPUT_CHARS:
        return text
    head_len = int(MAX_INPUT_CHARS * 0.7)
    tail_len = MAX_INPUT_CHARS - head_len
    return f"{text[:head_len]}\n\n[... truncated ...]\n\n{text[-tail_len:]}"


def build_messages(document_text: str, completion: dict | None = None) -> list[dict]:
    """
    Builds the chat-message list for one example.

    - completion=None:      training/inference prompt only (no assistant turn).
    - completion={...}:      full training example, with the assistant's JSON
                              answer appended as the last message.
    """
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": truncate_for_prompt(document_text)},
    ]
    if completion is not None:
        messages.append({"role": "assistant", "content": json.dumps(completion, ensure_ascii=False)})
    return messages
