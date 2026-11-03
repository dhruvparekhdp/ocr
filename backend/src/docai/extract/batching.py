"""Group related documents (invoice + its PO + receipt) by shared batch-key values: union-find over every
field marked isBatchKey, ported from legacy/index.js segregateIntoBatches."""

import re
from dataclasses import dataclass, field
from typing import Any


@dataclass
class BatchItem:
    document_id: str
    filename: str
    document_type: str
    values: dict[str, Any] = field(default_factory=dict)


def _key(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return re.sub(r"\s+", "", str(value)).casefold()


def segregate(items: list[BatchItem], batch_keys: list[str]) -> dict[str, Any]:
    parent = list(range(len(items)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    # A PO's documentNumber links to an invoice's referenceNumber, so all key fields share one value space.
    first_seen: dict[str, int] = {}
    for index, item in enumerate(items):
        for name in batch_keys:
            key = _key(item.values.get(name))
            if key is None:
                continue
            if key in first_seen:
                parent[find(index)] = find(first_seen[key])
            else:
                first_seen[key] = index

    groups: dict[int, list[BatchItem]] = {}
    for index, item in enumerate(items):
        groups.setdefault(find(index), []).append(item)

    batches, unbatched, conflicts = [], [], []
    for members in groups.values():
        summary = [
            {"document_id": m.document_id, "filename": m.filename, "document_type": m.document_type} for m in members
        ]
        if len(members) < 2:
            unbatched.extend(summary)
            continue
        keys: dict[str, str] = {}
        for name in batch_keys:
            for m in members:
                value = m.values.get(name)
                if value in (None, ""):
                    continue
                if name in keys and _key(keys[name]) != _key(value):
                    conflicts.append(f"{name}: {keys[name]} vs {value}")
                keys.setdefault(name, str(value))
        label = next(iter(keys.values()), f"GROUP-{len(batches) + 1}")
        batches.append({"batch_id": f"BATCH-{label}", "keys": keys, "documents": summary})
    return {"batches": batches, "unbatched": unbatched, "conflicts": conflicts}
