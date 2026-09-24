"""Analyze raw Shenmen PPG CSV files and create JSON feature reports."""

from __future__ import annotations

import argparse
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import mean

from .features import extract_waveform_features
from .io import read_rows, unique_metadata


def analyze_csv(path: str | Path) -> dict:
    rows = read_rows(path)
    metadata = unique_metadata(rows)
    grouped: dict[tuple[str, float, int, str], list[dict[str, str]]] = defaultdict(list)
    warnings: list[str] = []

    for row in rows:
        key = (
            row["phase"],
            round(float(row["pressure_level_n"]), 3),
            int(float(row["wavelength_nm"])),
            row["channel"],
        )
        grouped[key].append(row)

    segments: list[dict] = []
    for (phase, pressure, wavelength, channel), group_rows in sorted(grouped.items()):
        group_rows = sorted(group_rows, key=lambda item: float(item["timestamp_s"]))
        timestamps = [float(item["timestamp_s"]) for item in group_rows]
        values = [float(item["raw_ppg"]) for item in group_rows]
        forces = [float(item["contact_force_n"]) for item in group_rows]
        motion = [
            math.sqrt(float(item["imu_x"]) ** 2 + float(item["imu_y"]) ** 2 + (float(item["imu_z"]) - 1.0) ** 2)
            for item in group_rows
        ]
        features = extract_waveform_features(timestamps, values).to_dict()
        segment = {
            "phase": phase,
            "pressure_level_n": pressure,
            "wavelength_nm": wavelength,
            "channel": channel,
            "sample_count": len(group_rows),
            "force_mean_n": mean(forces) if forces else 0.0,
            "force_error_n": abs((mean(forces) if forces else 0.0) - pressure),
            "motion_mean": mean(motion) if motion else 0.0,
            "features": features,
        }
        if segment["force_error_n"] > 0.08:
            segment["quality_note"] = "force_out_of_tolerance"
        elif segment["motion_mean"] > 0.05:
            segment["quality_note"] = "motion_artifact_risk"
        else:
            segment["quality_note"] = "ok"
        segments.append(segment)

    best_pressure = select_best_pressure(segments)
    shenmen_features = compute_shenmen_features(segments, best_pressure)
    if best_pressure == 0.0:
        warnings.append("No valid center_ht7 525 nm pressure-sweep segment was found.")
    if shenmen_features.get("best_pressure_quality_score", 0.0) < 0.45:
        warnings.append("Best-pressure signal quality is low; repeat acquisition or reposition sensor.")
    warnings.append("This report quantifies HT7 pulse-wave features only and does not provide a clinical diagnosis.")

    return {
        "report_type": "Shenmen pulse wave quantification report",
        "metadata": metadata,
        "input_file": str(path),
        "best_pressure_n": best_pressure,
        "shenmen_features": shenmen_features,
        "segments": segments,
        "warnings": warnings,
    }


def select_best_pressure(segments: list[dict]) -> float:
    candidates = [
        segment
        for segment in segments
        if segment["phase"] == "pressure_sweep"
        and segment["channel"] == "center_ht7"
        and segment["wavelength_nm"] == 525
        and segment["quality_note"] == "ok"
    ]
    if not candidates:
        return 0.0
    max_amplitude = max((item["features"]["amplitude"] for item in candidates), default=0.0) or 1e-9
    best = max(
        candidates,
        key=lambda item: 0.55 * item["features"]["quality_score"] + 0.45 * (item["features"]["amplitude"] / max_amplitude),
    )
    return float(best["pressure_level_n"])


def compute_shenmen_features(segments: list[dict], best_pressure: float) -> dict:
    center_segments = [
        segment
        for segment in segments
        if segment["channel"] == "center_ht7" and segment["wavelength_nm"] == 525 and segment["phase"] == "pressure_sweep"
    ]
    center_segments = sorted(center_segments, key=lambda item: item["pressure_level_n"])
    pressure_curve = [
        {
            "pressure_level_n": segment["pressure_level_n"],
            "amplitude": segment["features"]["amplitude"],
            "quality_score": segment["features"]["quality_score"],
        }
        for segment in center_segments
    ]
    peak_amplitude = max((point["amplitude"] for point in pressure_curve), default=0.0)
    pressure_response_slope = _linear_slope(
        [point["pressure_level_n"] for point in pressure_curve],
        [point["amplitude"] for point in pressure_curve],
    )
    best_segment = _find_segment(segments, "pressure_sweep", best_pressure, 525, "center_ht7")
    if best_segment is None:
        best_segment = _find_segment(segments, "best_pressure", best_pressure, 525, "center_ht7")

    radial = _find_segment(segments, "pressure_sweep", best_pressure, 525, "radial_ref")
    ulnar = _find_segment(segments, "pressure_sweep", best_pressure, 525, "ulnar_ref")
    center_amp = best_segment["features"]["amplitude"] if best_segment else 0.0
    ref_amps = [
        segment["features"]["amplitude"]
        for segment in (radial, ulnar)
        if segment is not None and segment["features"]["amplitude"] > 0
    ]
    ref_amp_mean = mean(ref_amps) if ref_amps else 0.0
    center_to_ref_ratio = center_amp / ref_amp_mean if ref_amp_mean else 0.0
    reference_similarity = _reference_similarity(best_segment, radial, ulnar)

    return {
        "best_pressure_n": best_pressure,
        "best_pressure_quality_score": best_segment["features"]["quality_score"] if best_segment else 0.0,
        "pressure_curve": pressure_curve,
        "pressure_peak_amplitude": peak_amplitude,
        "pressure_response_slope": pressure_response_slope,
        "center_to_reference_amplitude_ratio": center_to_ref_ratio,
        "reference_morphology_similarity": reference_similarity,
        "center_ht7_best_features": best_segment["features"] if best_segment else {},
    }


def _find_segment(segments: list[dict], phase: str, pressure: float, wavelength: int, channel: str) -> dict | None:
    for segment in segments:
        if (
            segment["phase"] == phase
            and abs(segment["pressure_level_n"] - pressure) < 0.001
            and segment["wavelength_nm"] == wavelength
            and segment["channel"] == channel
        ):
            return segment
    return None


def _linear_slope(xs: list[float], ys: list[float]) -> float:
    if len(xs) < 2 or len(xs) != len(ys):
        return 0.0
    avg_x = mean(xs)
    avg_y = mean(ys)
    den = sum((x - avg_x) ** 2 for x in xs)
    if den == 0:
        return 0.0
    return sum((x - avg_x) * (y - avg_y) for x, y in zip(xs, ys)) / den


def _reference_similarity(center: dict | None, radial: dict | None, ulnar: dict | None) -> float:
    if not center:
        return 0.0
    refs = [segment for segment in (radial, ulnar) if segment is not None]
    if not refs:
        return 0.0
    keys = ("rise_time_s", "half_width_s", "reflection_index", "stiffness_index")
    sims: list[float] = []
    for ref in refs:
        local_scores = []
        for key in keys:
            a = float(center["features"].get(key, 0.0))
            b = float(ref["features"].get(key, 0.0))
            denom = max(abs(a), abs(b), 1e-9)
            local_scores.append(max(0.0, 1.0 - abs(a - b) / denom))
        sims.append(mean(local_scores))
    return mean(sims)


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze Shenmen pulse raw CSV data")
    parser.add_argument("csv_path", help="Input raw CSV path")
    parser.add_argument("--out", default="examples/demo_report.json", help="Output JSON report path")
    args = parser.parse_args()

    report = analyze_csv(args.csv_path)
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote JSON report to {target}")


if __name__ == "__main__":
    main()

