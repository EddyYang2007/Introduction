"""CSV input/output helpers."""

from __future__ import annotations

import csv
from pathlib import Path
from typing import Iterable

from .schema import RAW_COLUMNS, Sample, validate_row


def write_samples(path: str | Path, samples: Iterable[Sample]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=RAW_COLUMNS)
        writer.writeheader()
        for sample in samples:
            writer.writerow(sample.to_row())


def read_rows(path: str | Path) -> list[dict[str, str]]:
    with Path(path).open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    if not rows:
        raise ValueError("Raw CSV is empty")
    for row in rows:
        validate_row(row)
    return rows


def unique_metadata(rows: list[dict[str, str]]) -> dict[str, str]:
    first = rows[0]
    keys = ("subject_id", "session_id", "side", "operator_id")
    return {key: first[key] for key in keys}

