"""Small zero-dependency DSP helpers for PPG-like waveforms."""

from __future__ import annotations

import math
from statistics import mean, median


def moving_average(values: list[float], window: int) -> list[float]:
    if window <= 1 or len(values) < 3:
        return values[:]
    window = max(1, int(window))
    half = window // 2
    out: list[float] = []
    prefix = [0.0]
    for value in values:
        prefix.append(prefix[-1] + value)
    for index in range(len(values)):
        start = max(0, index - half)
        end = min(len(values), index + half + 1)
        out.append((prefix[end] - prefix[start]) / (end - start))
    return out


def detrend(values: list[float], sample_rate_hz: float) -> list[float]:
    baseline_window = max(3, int(sample_rate_hz * 1.5))
    baseline = moving_average(values, baseline_window)
    return [value - base for value, base in zip(values, baseline)]


def smooth(values: list[float], sample_rate_hz: float) -> list[float]:
    window = max(3, int(sample_rate_hz * 0.04))
    if window % 2 == 0:
        window += 1
    return moving_average(values, window)


def preprocess(values: list[float], sample_rate_hz: float) -> list[float]:
    return smooth(detrend(values, sample_rate_hz), sample_rate_hz)


def derivative(values: list[float], sample_rate_hz: float) -> list[float]:
    if len(values) < 2:
        return [0.0 for _ in values]
    dt = 1.0 / sample_rate_hz
    out = [0.0]
    for prev, cur in zip(values, values[1:]):
        out.append((cur - prev) / dt)
    return out


def standard_deviation(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    avg = mean(values)
    return math.sqrt(sum((value - avg) ** 2 for value in values) / (len(values) - 1))


def rms_successive_diff(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    diffs = [cur - prev for prev, cur in zip(values, values[1:])]
    return math.sqrt(mean([diff * diff for diff in diffs]))


def percentile(values: list[float], percent: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    rank = (len(ordered) - 1) * percent / 100.0
    lower = int(math.floor(rank))
    upper = int(math.ceil(rank))
    if lower == upper:
        return ordered[lower]
    ratio = rank - lower
    return ordered[lower] * (1.0 - ratio) + ordered[upper] * ratio


def robust_amplitude(values: list[float]) -> float:
    return percentile(values, 95) - percentile(values, 5)


def find_peaks(values: list[float], sample_rate_hz: float, min_bpm: float = 40.0, max_bpm: float = 180.0) -> list[int]:
    if len(values) < 3:
        return []
    min_distance = max(1, int(sample_rate_hz * 60.0 / max_bpm))
    threshold = median(values) + 0.25 * robust_amplitude(values)
    candidates: list[int] = []
    for index in range(1, len(values) - 1):
        if values[index] > threshold and values[index] >= values[index - 1] and values[index] > values[index + 1]:
            candidates.append(index)

    peaks: list[int] = []
    for candidate in candidates:
        if not peaks or candidate - peaks[-1] >= min_distance:
            peaks.append(candidate)
            continue
        if values[candidate] > values[peaks[-1]]:
            peaks[-1] = candidate
    max_distance = int(sample_rate_hz * 60.0 / min_bpm)
    return [peak for peak in peaks if peak >= 0 and peak < len(values) and (not peaks or max_distance > 0)]


def zero_crossings(values: list[float]) -> list[int]:
    crossings: list[int] = []
    for index in range(1, len(values)):
        if values[index - 1] <= 0.0 < values[index] or values[index - 1] >= 0.0 > values[index]:
            crossings.append(index)
    return crossings

