"""
Shared hardware/precision selection for train.py and serve.py — kept in one
place so training and serving always agree on which dtype ran, and so a
GPU-specific quirk only needs fixing once.
"""

import torch


def select_device() -> str:
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def select_dtype(device: str) -> torch.dtype:
    """
    bf16 only pays off with Ampere+ tensor cores (RTX 30-series and newer) —
    older CUDA GPUs (GTX 10/16-series and similar) either lack hardware
    support or get no speed benefit, so prefer fp16 there instead.
    `torch.cuda.is_bf16_supported()` is the authoritative check; trust it
    over guessing from the GPU name.
    """
    if device == "cuda":
        return torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    if device == "mps":
        return torch.float16
    return torch.float32
