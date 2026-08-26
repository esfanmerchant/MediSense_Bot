"""Shared response shapes.

Every successful response is ``{"success": true, "data": ...}``, optionally with
``meta`` for pagination, so clients parse one envelope everywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import Query


def ok(data: Any, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {"success": True, "data": data}
    if meta is not None:
        body["meta"] = meta
    return body


@dataclass(frozen=True)
class Page:
    limit: int
    offset: int

    def meta(self, total: int) -> dict[str, Any]:
        return {
            "total": total,
            "limit": self.limit,
            "offset": self.offset,
            "hasMore": self.offset + self.limit < total,
        }


def pagination(
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> Page:
    """Bounded by design: an unbounded list endpoint over patient data is both a
    performance problem and a bulk-exfiltration primitive."""
    return Page(limit=limit, offset=offset)
