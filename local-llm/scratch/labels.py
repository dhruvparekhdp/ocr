"""
Shared label scheme for the from-scratch model — used identically by
prepare_dataset.py (encoding labels into tags) and serve.py (decoding tags
back into labels), so the two can never drift apart.

Two independent label types on one shared encoder:
  - documentType: whole-document classification, one of DOC_TYPES.
  - invoiceNumber / poNumber: token-level BIO tagging. Extraction is framed
    as tagging (not generation) because a from-scratch model has no
    pretrained ability to "copy text out of context" — tagging just asks it
    to point at which tokens are part of the identifier, which is a much
    easier thing to learn from a modest dataset. The literal substring is
    recovered afterward via the tokenizer's character offsets, not by
    decoding token ids back to text (which can mangle whitespace/casing).
"""

# Must match docTypes.js in the Node app exactly.
DOC_TYPES = ["PO", "Invoice", "AWB_BL", "Shipping Bill", "Unknown"]

# BIO tags: Outside, Begin/Inside-Invoice-number, Begin/Inside-PO-number.
TAGS = ["O", "B-INV", "I-INV", "B-PO", "I-PO"]
TAG_TO_ID = {tag: i for i, tag in enumerate(TAGS)}
ID_TO_TAG = {i: tag for i, tag in enumerate(TAGS)}

# Loss-masking sentinel for special/padding tokens — must match
# CrossEntropyLoss(ignore_index=...) in train.py.
IGNORE_INDEX = -100


def find_span_tags(text: str, offsets: list[tuple[int, int]], target: str | None, tag_prefix: str) -> list[str]:
    """
    Locates every occurrence of `target` (an identifier string, e.g. an
    invoice number) inside `text`, and returns a BIO tag for each token
    (aligned to `offsets`, the tokenizer's per-token (start_char, end_char)
    spans). Tags all occurrences, not just the first — an invoice number
    often appears multiple times in one document (header, table, footer),
    and reinforcing every occurrence gives the model more training signal
    without meaningfully risking false positives for a specific reference
    string of non-trivial length.

    Returns a list of "O" (all outside) if `target` is None/empty or isn't
    found verbatim in `text` — callers should track how often this happens
    per field, since a high miss rate means the identifier isn't appearing
    exactly as labeled (whitespace differences, OCR artifacts, etc.).
    """
    tags = ["O"] * len(offsets)
    if not target:
        return tags

    search_start = 0
    found_any = False
    while True:
        idx = text.find(target, search_start)
        if idx == -1:
            break
        found_any = True
        span_start, span_end = idx, idx + len(target)
        first_token_in_span = True
        for i, (tok_start, tok_end) in enumerate(offsets):
            if tok_end <= tok_start:
                continue  # special token with an empty/placeholder offset
            if tok_start < span_end and tok_end > span_start:
                tags[i] = f"B-{tag_prefix}" if first_token_in_span else f"I-{tag_prefix}"
                first_token_in_span = False
        search_start = idx + 1  # allow overlapping/adjacent repeats to still be found

    return tags if found_any else tags


def decode_span(text: str, offsets: list[tuple[int, int]], tag_ids: list[int], tag_prefix: str) -> str | None:
    """
    Inverse of find_span_tags for a single field: scans predicted tag ids
    for the first B-<prefix> ... I-<prefix>* run, and returns the exact
    source substring spanning those tokens (via offsets), or None if no
    B-<prefix> tag was predicted anywhere.

    Strips the result: byte-level BPE tokens absorb the leading space of the
    word they start (e.g. "INV" tokenizes as "ĠINV", whose offset covers the
    space *before* "I"), so slicing by raw token boundaries can include one
    leading space that isn't part of the identifier itself. Stripping is the
    standard, sufficient fix for this — the identifier's own characters are
    never split by it, only incidental surrounding whitespace is.
    """
    b_id = TAG_TO_ID[f"B-{tag_prefix}"]
    i_id = TAG_TO_ID[f"I-{tag_prefix}"]

    start_tok = None
    end_tok = None
    for i, tag_id in enumerate(tag_ids):
        if tag_id == b_id and start_tok is None:
            start_tok = i
            end_tok = i
        elif tag_id == i_id and start_tok is not None and end_tok == i - 1:
            end_tok = i
        elif start_tok is not None:
            break  # run ended

    if start_tok is None:
        return None

    char_start = offsets[start_tok][0]
    char_end = offsets[end_tok][1]
    decoded = text[char_start:char_end].strip()
    return decoded or None
