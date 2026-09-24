"""Render Markdown reports from analyzer JSON."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def render_markdown(report: dict) -> str:
    metadata = report.get("metadata", {})
    shenmen = report.get("shenmen_features", {})
    center = shenmen.get("center_ht7_best_features", {})
    pressure_curve = shenmen.get("pressure_curve", [])
    warnings = report.get("warnings", [])

    lines = [
        "# Shenmen Pulse Wave Quantification Report",
        "",
        "## Metadata",
        "",
        f"- Subject ID: `{metadata.get('subject_id', '')}`",
        f"- Session ID: `{metadata.get('session_id', '')}`",
        f"- Wrist side: `{metadata.get('side', '')}`",
        f"- Operator: `{metadata.get('operator_id', '')}`",
        f"- Best pressure: `{report.get('best_pressure_n', 0.0):.3f} N`",
        "",
        "## Core HT7 Features",
        "",
        f"- Pulse rate: `{center.get('pulse_rate_bpm', 0.0):.2f} bpm`",
        f"- Beat count: `{center.get('beat_count', 0)}`",
        f"- PP interval mean: `{center.get('pp_interval_mean_s', 0.0):.4f} s`",
        f"- SDNN: `{center.get('pp_interval_sdnn_s', 0.0):.4f} s`",
        f"- RMSSD: `{center.get('pp_interval_rmssd_s', 0.0):.4f} s`",
        f"- Amplitude: `{center.get('amplitude', 0.0):.6f}`",
        f"- AC/DC ratio: `{center.get('ac_dc_ratio', 0.0):.6f}`",
        f"- Rise time: `{center.get('rise_time_s', 0.0):.4f} s`",
        f"- Half width: `{center.get('half_width_s', 0.0):.4f} s`",
        f"- Reflection index: `{center.get('reflection_index', 0.0):.4f}`",
        f"- Stiffness index: `{center.get('stiffness_index', 0.0):.4f}`",
        f"- Quality score: `{center.get('quality_score', 0.0):.4f}`",
        "",
        "## Shenmen-Specific Metrics",
        "",
        f"- Pressure peak amplitude: `{shenmen.get('pressure_peak_amplitude', 0.0):.6f}`",
        f"- Pressure response slope: `{shenmen.get('pressure_response_slope', 0.0):.6f}`",
        f"- Center/reference amplitude ratio: `{shenmen.get('center_to_reference_amplitude_ratio', 0.0):.4f}`",
        f"- Reference morphology similarity: `{shenmen.get('reference_morphology_similarity', 0.0):.4f}`",
        "",
        "## Pressure Response",
        "",
        "| Pressure (N) | Amplitude | Quality |",
        "|---:|---:|---:|",
    ]
    for point in pressure_curve:
        lines.append(
            f"| {point.get('pressure_level_n', 0.0):.3f} | {point.get('amplitude', 0.0):.6f} | {point.get('quality_score', 0.0):.4f} |"
        )
    lines.extend(
        [
            "",
            "## Interpretation Boundary",
            "",
            "This report quantifies HT7 local pulse-wave features. It does not provide clinical diagnosis or emotional-disorder classification.",
            "",
            "## Warnings",
            "",
        ]
    )
    for warning in warnings:
        lines.append(f"- {warning}")
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Render Shenmen pulse JSON report as Markdown")
    parser.add_argument("json_path", help="Input JSON report")
    parser.add_argument("--out", default="examples/demo_report.md", help="Output Markdown path")
    args = parser.parse_args()

    report = json.loads(Path(args.json_path).read_text(encoding="utf-8"))
    markdown = render_markdown(report)
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(markdown, encoding="utf-8")
    print(f"Wrote Markdown report to {target}")


if __name__ == "__main__":
    main()

