"""Feature extraction for local Shenmen pulse waves."""

from __future__ import annotations

import math
from dataclasses import dataclass
from statistics import mean, median

from .dsp import (
    derivative,
    find_peaks,
    preprocess,
    robust_amplitude,
    rms_successive_diff,
    standard_deviation,
)


@dataclass
class WaveformFeatures:
    sample_count: int
    duration_s: float
    pulse_rate_bpm: float
    beat_count: int
    pp_interval_mean_s: float
    pp_interval_sdnn_s: float
    pp_interval_rmssd_s: float
    amplitude: float
    ac_dc_ratio: float
    rise_time_s: float
    decay_time_s: float
    half_width_s: float
    area: float
    reflection_index: float
    stiffness_index: float
    notch_score: float
    apg_a: float
    apg_b: float
    apg_c: float
    apg_d: float
    apg_e: float
    apg_b_over_a: float
    apg_c_over_a: float
    apg_d_over_a: float
    apg_e_over_a: float
    quality_score: float

    def to_dict(self) -> dict[str, float | int]:
        return self.__dict__.copy()


def infer_sample_rate(timestamps: list[float]) -> float:
    if len(timestamps) < 2:
        return 1.0
    diffs = [cur - prev for prev, cur in zip(timestamps, timestamps[1:]) if cur > prev]
    if not diffs:
        return 1.0
    return 1.0 / median(diffs)


def _beat_windows(peaks: list[int], sample_rate_hz: float, length: int | None = None) -> list[tuple[int, int, int]]:
    windows: list[tuple[int, int, int]] = []
    span = int(sample_rate_hz * 0.8)
    pre = int(sample_rate_hz * 0.35)
    post = int(sample_rate_hz * 0.65)
    for idx, peak in enumerate(peaks):
        if idx > 0 and idx < len(peaks) - 1:
            start = (peaks[idx - 1] + peak) // 2
            end = (peak + peaks[idx + 1]) // 2
        else:
            start = peak - pre
            end = peak + post
        start = max(0, start)
        end = max(start + 2, min(start + span, end))
        if length is not None:
            end = min(end, length)
            start = min(start, max(0, length - 2))
            peak = min(max(start, peak), max(start, end - 1))
        if end - start >= 2:
            windows.append((start, peak, end))
    return windows


def _half_width(values: list[float], start: int, peak: int, end: int, sample_rate_hz: float) -> float:
    end = min(end, len(values))
    peak = min(max(start, peak), end - 1)
    segment = values[start:end]
    if not segment:
        return 0.0
    base = min(segment)
    height = values[peak] - base
    if height <= 0:
        return 0.0
    half = base + 0.5 * height
    left = peak
    while left > start and values[left] > half:
        left -= 1
    right = peak
    while right < end - 1 and values[right] > half:
        right += 1
    return max(0.0, (right - left) / sample_rate_hz)


def _secondary_peak(values: list[float], peak: int, end: int) -> float:
    search_start = peak + max(1, (end - peak) // 5)
    search_end = end
    if search_start >= search_end:
        return 0.0
    return max(values[search_start:search_end])


def _apg_features(values: list[float], sample_rate_hz: float, peaks: list[int]) -> dict[str, float]:
    if len(values) < 5 or not peaks:
        return _empty_apg()
    first = derivative(values, sample_rate_hz)
    second = derivative(first, sample_rate_hz)
    windows = _beat_windows(peaks[: min(20, len(peaks))], sample_rate_hz, len(values))
    waves = {"a": [], "b": [], "c": [], "d": [], "e": []}
    for start, peak, end in windows:
        segment = second[start:end]
        if len(segment) < 10:
            continue
        fifth = max(2, len(segment) // 5)
        a = max(segment[:fifth])
        b = min(segment[fifth : 2 * fifth])
        c = max(segment[2 * fifth : 3 * fifth])
        d = min(segment[3 * fifth : 4 * fifth])
        e = max(segment[4 * fifth :])
        waves["a"].append(a)
        waves["b"].append(b)
        waves["c"].append(c)
        waves["d"].append(d)
        waves["e"].append(e)
    if not waves["a"]:
        return _empty_apg()
    avg = {key: mean(vals) if vals else 0.0 for key, vals in waves.items()}
    a = avg["a"] or 1e-9
    return {
        "apg_a": avg["a"],
        "apg_b": avg["b"],
        "apg_c": avg["c"],
        "apg_d": avg["d"],
        "apg_e": avg["e"],
        "apg_b_over_a": avg["b"] / a,
        "apg_c_over_a": avg["c"] / a,
        "apg_d_over_a": avg["d"] / a,
        "apg_e_over_a": avg["e"] / a,
    }


def _empty_apg() -> dict[str, float]:
    return {
        "apg_a": 0.0,
        "apg_b": 0.0,
        "apg_c": 0.0,
        "apg_d": 0.0,
        "apg_e": 0.0,
        "apg_b_over_a": 0.0,
        "apg_c_over_a": 0.0,
        "apg_d_over_a": 0.0,
        "apg_e_over_a": 0.0,
    }


def extract_waveform_features(timestamps: list[float], raw_values: list[float]) -> WaveformFeatures:
    if len(timestamps) != len(raw_values):
        raise ValueError("timestamps and raw_values must have the same length")
    if len(timestamps) < 10:
        raise ValueError("Need at least 10 samples to extract waveform features")

    sample_rate = infer_sample_rate(timestamps)
    values = preprocess(raw_values, sample_rate)
    peaks = find_peaks(values, sample_rate)
    duration = max(timestamps) - min(timestamps) if len(timestamps) > 1 else len(timestamps) / sample_rate
    intervals = [(b - a) / sample_rate for a, b in zip(peaks, peaks[1:])]
    valid_intervals = [interval for interval in intervals if 0.33 <= interval <= 1.5]
    pulse_rate = 60.0 / mean(valid_intervals) if valid_intervals else 0.0

    windows = _beat_windows(peaks, sample_rate, len(values))
    amplitudes: list[float] = []
    rise_times: list[float] = []
    decay_times: list[float] = []
    half_widths: list[float] = []
    areas: list[float] = []
    reflection_indexes: list[float] = []
    stiffness_indexes: list[float] = []
    notch_scores: list[float] = []

    for start, peak, end in windows:
        segment = values[start:end]
        if len(segment) < 3:
            continue
        trough_offset = min(range(len(segment[: max(1, peak - start + 1)])), key=lambda idx: segment[idx])
        trough = start + trough_offset
        amp = values[peak] - values[trough]
        if amp <= 0:
            continue
        amplitudes.append(amp)
        rise_times.append(max(0.0, (peak - trough) / sample_rate))
        decay_times.append(max(0.0, (end - peak) / sample_rate))
        half_widths.append(_half_width(values, start, peak, end, sample_rate))
        areas.append(sum(max(0.0, value - values[trough]) for value in segment) / sample_rate)
        secondary = _secondary_peak(values, peak, end)
        reflection_indexes.append(max(0.0, secondary - values[trough]) / amp)
        if peak > trough:
            stiffness_indexes.append(1.0 / max(1e-6, (peak - trough) / sample_rate))
        notch_scores.append(max(0.0, (values[peak] - secondary) / amp))

    dc_level = abs(mean(raw_values)) or 1e-9
    amp_value = mean(amplitudes) if amplitudes else robust_amplitude(values)
    quality = _quality_score(
        beat_count=len(peaks),
        duration_s=duration,
        amplitude=amp_value,
        interval_sd=standard_deviation(valid_intervals),
        raw_values=raw_values,
    )
    apg = _apg_features(values, sample_rate, peaks)

    return WaveformFeatures(
        sample_count=len(raw_values),
        duration_s=duration,
        pulse_rate_bpm=pulse_rate,
        beat_count=len(peaks),
        pp_interval_mean_s=mean(valid_intervals) if valid_intervals else 0.0,
        pp_interval_sdnn_s=standard_deviation(valid_intervals),
        pp_interval_rmssd_s=rms_successive_diff(valid_intervals),
        amplitude=amp_value,
        ac_dc_ratio=amp_value / dc_level,
        rise_time_s=mean(rise_times) if rise_times else 0.0,
        decay_time_s=mean(decay_times) if decay_times else 0.0,
        half_width_s=mean(half_widths) if half_widths else 0.0,
        area=mean(areas) if areas else 0.0,
        reflection_index=mean(reflection_indexes) if reflection_indexes else 0.0,
        stiffness_index=mean(stiffness_indexes) if stiffness_indexes else 0.0,
        notch_score=mean(notch_scores) if notch_scores else 0.0,
        quality_score=quality,
        **apg,
    )


def _quality_score(beat_count: int, duration_s: float, amplitude: float, interval_sd: float, raw_values: list[float]) -> float:
    if duration_s <= 0:
        return 0.0
    expected_beats = max(1.0, duration_s)
    beat_density = min(1.0, beat_count / expected_beats)
    amplitude_score = min(1.0, max(0.0, amplitude * 20.0))
    rhythm_score = max(0.0, 1.0 - min(1.0, interval_sd / 0.18))
    saturation_count = sum(1 for value in raw_values if abs(value) > 0.98)
    saturation_penalty = min(0.5, saturation_count / max(1, len(raw_values)))
    score = 0.35 * beat_density + 0.35 * amplitude_score + 0.30 * rhythm_score - saturation_penalty
    return max(0.0, min(1.0, score))

