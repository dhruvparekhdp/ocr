"""
The from-scratch model: a small transformer encoder, randomly initialized
(no pretrained checkpoint, no Qwen), with two task heads on top:
  - documentType: classification over pooled encoder output.
  - invoiceNumber / poNumber: per-token BIO tagging (see labels.py).

Sized deliberately small (a few million parameters, not hundreds of
millions) — this model has no pretrained head start, so it needs to learn
everything from your labeled data alone; keeping it small keeps that data
requirement (and training time on modest hardware) reasonable.
"""

import math

import torch
import torch.nn as nn


class PositionalEncoding(nn.Module):
    """Standard sinusoidal positional encoding (fixed, not learned — one less thing to train from scratch)."""

    def __init__(self, embed_dim: int, max_len: int):
        super().__init__()
        position = torch.arange(max_len).unsqueeze(1)
        div_term = torch.exp(torch.arange(0, embed_dim, 2) * (-math.log(10000.0) / embed_dim))
        pe = torch.zeros(max_len, embed_dim)
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0))  # (1, max_len, embed_dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.pe[:, : x.size(1)]


class DocumentModel(nn.Module):
    def __init__(
        self,
        vocab_size: int,
        num_doc_types: int,
        num_tags: int,
        embed_dim: int = 256,
        num_layers: int = 4,
        num_heads: int = 4,
        ff_dim: int = 512,
        max_seq_len: int = 512,
        dropout: float = 0.1,
        pad_token_id: int = 0,
    ):
        super().__init__()
        self.pad_token_id = pad_token_id

        self.embedding = nn.Embedding(vocab_size, embed_dim, padding_idx=pad_token_id)
        self.positional_encoding = PositionalEncoding(embed_dim, max_seq_len)
        self.dropout = nn.Dropout(dropout)

        encoder_layer = nn.TransformerEncoderLayer(
            d_model=embed_dim,
            nhead=num_heads,
            dim_feedforward=ff_dim,
            dropout=dropout,
            activation="gelu",
            batch_first=True,
        )
        self.encoder = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)

        self.classifier_head = nn.Linear(embed_dim, num_doc_types)
        self.tagging_head = nn.Linear(embed_dim, num_tags)

    def forward(self, input_ids: torch.Tensor, attention_mask: torch.Tensor):
        """
        input_ids, attention_mask: (batch, seq_len). attention_mask is 1 for
        real tokens, 0 for padding.

        Returns (doc_type_logits, tag_logits):
          doc_type_logits: (batch, num_doc_types)
          tag_logits:       (batch, seq_len, num_tags)
        """
        x = self.embedding(input_ids)
        x = self.positional_encoding(x)
        x = self.dropout(x)

        # nn.TransformerEncoder's key_padding_mask expects True at POSITIONS
        # TO IGNORE — i.e. the padding, the inverse of attention_mask.
        key_padding_mask = attention_mask == 0
        hidden = self.encoder(x, src_key_padding_mask=key_padding_mask)

        # Masked mean pooling for classification — plain mean would let
        # padding (zero vectors, but post-encoder they're not exactly zero)
        # dilute the signal, especially for short documents in a padded batch.
        mask = attention_mask.unsqueeze(-1).to(hidden.dtype)
        summed = (hidden * mask).sum(dim=1)
        counts = mask.sum(dim=1).clamp(min=1e-6)
        pooled = summed / counts

        doc_type_logits = self.classifier_head(pooled)
        tag_logits = self.tagging_head(hidden)

        return doc_type_logits, tag_logits
