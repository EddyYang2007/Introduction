"""Generate synthetic Shenmen pulse CSV data for development and tests."""

from __future__ import annotations

import argparse
import math
import random
from pathlib import Path

from .io import write_samples
from .schema import CHANNELS, PRESSURE_LEVELS_N, WAVELENGTHS_NM, Sample


def pressure_gain(force_n: float, optimal_n: float = 1.2) -> float:
    return math.exp(-((force_n - optimal_n) ** 2) / (2 * 0.45**2))


def pulse_shape(phase: float) -> float:
    systolic = math.exp(-((phase - 0.18) ** 2) / (2 * 0.035**2))
    reflected = 0.34 * math.exp(-((phase - 0.48) ** 2) / (2 * 0.08**2))
    baseline = 0.04 * math.sin(2 * math.pi * phase)
    return systolic + reflected + baseline


def generate_samples(
    subject_id: str = "SUBJ_DEMO",
    session_id: str = "SESSION_DEMO",
    side: str = "left",
    operator_id: str = "OP001",
    sample_rate_hz: int = 250,
    sweep_seconds: float = 30.0,
    best_seconds: float = 120.0,
    seed: int = 42,
) -> list[Sample]:
    rng = random.Random(seed)
    rows: list[Sample] = []
    current_t = 0.0
    heart_rate_bpm = 72.0 + rng.uniform(-3.0, 3.0)
    beat_period = 60.0 / heart_rate_bpm
    channel_gain = {"center_ht7": 1.0, "radial_ref": 0.72, "ulnar_ref": 0.66}
    wavelength_gain = {525: 1.0, 660: 0.72, 940: 0.56}

    for pressure in PRESSURE_LEVELS_N:
        rows.extend(
            _segment(
                subject_id,
                session_id,
                side,
                operator_id,
                "pressure_sweep",
                pressure,
                current_t,
                sweep_seconds,
                sample_rate_hz,
                beat_period,
                channel_gain,
                wavelength_gain,
                rng,
            )
        )
        current_t += sweep_seconds

    best_pressure = max(PRESSURE_LEVELS_N, key=pressure_gain)
    rows.extend(
        _segment(
            subject_id,
            session_id,
            side,
            operator_id,
            "best_pressure",
            best_pressure,
            current_t,
            best_seconds,
            sample_rate_hz,
            beat_period,
            channel_gain,
            wavelength_gain,
            rng,
        )
    )
    return rows


def _segment(
    subject_id: str,
    session_id: str,
    side: str,
    operator_id: str,
    phase: str,
    pressure: float,
    start_t: float,
    duration_s: float,
    sample_rate_hz: int,
    beat_period: float,
    channel_gain: dict[str, float],
    wavelength_gain: dict[int, float],
    rng: random.Random,
) -> list[Sample]:
    rows: list[Sample] = []
    n = int(duration_s * sample_rate_hz)
    gain = pressure_gain(pressure)
    for index in range(n):
        t = start_t + index / sample_rate_hz
        force = pressure + rng.gauss(0.0, 0.015)
        motion = 0.01 * math.sin(2 * math.pi * 0.23 * t) + rng.gauss(0.0, 0.006)
        phase_in_beat = (t % beat_period) / beat_period
        base_pulse = pulse_shape(phase_in_beat)
        respiration = 0.025 * math.sin(2 * math.pi * 0.25 * t)
        for wavelength in WAVELENGTHS_NM:
            for channel in CHANNELS:
                optical = 0.52 + respiration
                ppg = 0.11 * gain * channel_gain[channel] * wavelength_gain[wavelength] * base_pulse
                noise = rng.gauss(0.0, 0.0045)
                raw = optical + ppg + motion * 0.2 + noise
                rows.append(
                    Sample(
                        subject_id=subject_id,
                        session_id=session_id,
                        side=side,
                        operator_id=operator_id,
                        phase=phase,
                        pressure_level_n=pressure,
                        timestamp_s=t,
                        wavelength_nm=wavelength,
                        channel=channel,
                        raw_ppg=max(0.0, min(1.0, raw)),
                        contact_force_n=force,
                        imu_x=motion,
                        imu_y=rng.gauss(0.0, 0.003),
                        imu_z=1.0 + rng.gauss(0.0, 0.003),
                        temperature_c=32.0 + 0.3 * math.sin(2 * math.pi * t / 180.0),
                        quality_flag="",
                    )
                )
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate synthetic Shenmen pulse CSV data")
    parser.add_argument("--out", default="examples/demo_session.csv", help="Output CSV path")
    parser.add_argument("--subject-id", default="SUBJ_DEMO")
    parser.add_argument("--session-id", default="SESSION_DEMO")
    parser.add_argument("--side", choices=("left", "right"), default="left")
    parser.add_argument("--operator-id", default="OP001")
    parser.add_argument("--sample-rate-hz", type=int, default=250)
    args = parser.parse_args()

    samples = generate_samples(
        subject_id=args.subject_id,
        session_id=args.session_id,
        side=args.side,
        operator_id=args.operator_id,
        sample_rate_hz=args.sample_rate_hz,
    )
    write_samples(Path(args.out), samples)
    print(f"Wrote {len(samples)} rows to {args.out}")


if __name__ == "__main__":
    main()

