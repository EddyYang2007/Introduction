"""Build traceable optical-flow feature datasets from the calibration MCAPs.

The original ``strict`` route deliberately remains conservative: a training
label is admitted only when the recorded synchronized sample is valid, belongs
to an accepted hold window, and stays inside every timestamp-offset limit.

The separate ``force`` route is intentionally narrower in what it validates.
It trains against the E75 force reading, so it requires a valid trial, RGB,
finite E75 force, and image-to-E75 synchronisation.  It must *not* reject a
sample merely because the unrelated robot, difference-image, or deformation
streams are late.  That distinction keeps the old provenance dataset intact
while recovering the recorded light-touch ramp.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import tempfile
import time
from collections import Counter
from pathlib import Path

import cv2
import numpy as np
from mcap.reader import make_reader
from rosbags.typesys import Stores, get_types_from_msg, get_typestore

ROOT = Path(__file__).resolve().parent / "data" / "calibration_fixture"
OUT = Path(__file__).resolve().parent / "artifacts"
TRIALS = ROOT / "trials.jsonl"
REFERENCE = ROOT / "reference" / "no_contact.png"
PHASES = {"normal_load", "shear_1mm", "shear_2mm"}
FEATURE_SCHEMA_VERSION = "gel-optical-flow-production/v2"
QUALITY_POLICY_VERSION = "strict-sync/v1"
FORCE_DATASET_SCHEMA_VERSION = "gel-force-e75-frame/v1"
FORCE_QUALITY_POLICY_VERSION = "force-only-e75-sync/v1"
IMAGE_WRENCH_OFFSET_LIMIT_MS = 2.0
IMAGE_ROBOT_OFFSET_LIMIT_MS = 10.0
IMAGE_DERIVED_OFFSET_LIMIT_MS = 2.0
MIN_SAMPLES_PER_HOLD = 5

# The force-only route retains the transient ramp, rather than collapsing each
# stable hold to one median.  Caps are deliberately per physical trial/bin so
# a long recording cannot dominate the fit.  Pre-contact rows are selected at
# evenly spaced positions to give the model an explicit zero-force anchor.
FORCE_PHASES = {"precontact", "normal_load", "retract", "shear_1mm", "shear_2mm"}
FORCE_CONTACT_PHASES = FORCE_PHASES - {"precontact"}
FORCE_MIN_TARE_SAMPLES = 3
FORCE_MAX_SAMPLES_PER_TRIAL_BIN = 3
FORCE_PRECONTACT_SAMPLES_PER_TRIAL = 5
FORCE_BASELINE_IMAGES_PER_TRIAL = 9
FORCE_DATASET_NAME = "tactile_features_force.npz"
FORCE_MANIFEST_NAME = "tactile_features_force_manifest.json"

# The five fields between 40 and 44 are retained as diagnostics, not model
# inputs.  Keeping the production order explicit avoids the old 47 -> 42
# implicit slicing in the real-time frontend.
PRODUCTION_FEATURE_INDICES = tuple(range(40)) + (45, 46)


def load_trials():
    out = {}
    with TRIALS.open("r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                d = json.loads(line)
                if d.get("valid", False):
                    out[int(d["trial_index"])] = d
    return out


def make_store():
    # The primary rosbag is complete and contains every schema.  Do not depend
    # on filesystem enumeration, which can select a truncated final segment.
    first = ROOT / "rosbag" / "rosbag_0.mcap"
    with first.open("rb") as f:
        summary = make_reader(f).get_summary()
    store = get_typestore(Stores.ROS2_HUMBLE)
    for schema in summary.schemas.values():
        try:
            store.register(get_types_from_msg(schema.data.decode("utf-8"), schema.name))
        except Exception:
            pass
    return store


def score_layers(bgr: np.ndarray):
    b, g, r = [x.astype(np.float32) for x in cv2.split(bgr)]
    red = np.clip(r - 0.5 * (g + b), -128, 127) + 128
    blue = np.clip(b - 0.5 * (g + r), -128, 127) + 128
    return red.astype(np.uint8), blue.astype(np.uint8)


def flow_features(base_layer: np.ndarray, cur_layer: np.ndarray, prefix: str):
    flow = cv2.calcOpticalFlowFarneback(
        base_layer, cur_layer, None, 0.5, 3, 15, 3, 5, 1.2, 0
    )
    ux, uy = flow[..., 0], flow[..., 1]
    mag = np.sqrt(ux * ux + uy * uy)
    # Ignore the outer 4 px, where JPEG/ROI boundary artifacts dominate.
    core = np.s_[4:-4, 4:-4]
    uxc, uyc, mc = ux[core], uy[core], mag[core]
    gx_ux = cv2.Sobel(ux, cv2.CV_32F, 1, 0, ksize=3) * 0.125
    gy_uy = cv2.Sobel(uy, cv2.CV_32F, 0, 1, ksize=3) * 0.125
    gx_uy = cv2.Sobel(uy, cv2.CV_32F, 1, 0, ksize=3) * 0.125
    gy_ux = cv2.Sobel(ux, cv2.CV_32F, 0, 1, ksize=3) * 0.125
    div = (gx_ux + gy_uy)[core]
    curl = (gx_uy - gy_ux)[core]
    # Quantiles are among the dominant CPU cost in real-time Farneback feature
    # extraction.  A vector call preserves NumPy's interpolation semantics while
    # avoiding three independent traversals of ``mc``.
    mag_p50, mag_p75, mag_p90 = np.percentile(mc, [50, 75, 90])
    div_abs_p90 = np.percentile(np.abs(div), 90)
    curl_abs_p90 = np.percentile(np.abs(curl), 90)
    vals = [
        float(np.mean(uxc)), float(np.mean(uyc)), float(np.std(uxc)), float(np.std(uyc)),
        float(mag_p50), float(mag_p75), float(mag_p90),
        float(np.mean(div)), float(np.std(div)), float(div_abs_p90),
        float(np.mean(curl)), float(np.std(curl)), float(curl_abs_p90),
    ]
    return vals, flow


def image_features(base_bgr: np.ndarray, current: np.ndarray, difference: np.ndarray | None = None):
    if current.shape[:2] != base_bgr.shape[:2]:
        current = cv2.resize(current, (base_bgr.shape[1], base_bgr.shape[0]), interpolation=cv2.INTER_AREA)
    r0, b0 = score_layers(base_bgr)
    r1, b1 = score_layers(current)
    rvals, rf = flow_features(r0, r1, "r")
    bvals, bf = flow_features(b0, b1, "b")
    fused = 0.5 * (rf + bf)
    ux, uy = fused[..., 0], fused[..., 1]
    mag = np.sqrt(ux * ux + uy * uy)
    yy, xx = np.mgrid[:mag.shape[0], :mag.shape[1]]
    mask = mag > max(0.12, float(np.percentile(mag, 65)))
    w = np.where(mask, np.maximum(mag - 0.12, 0.0), 0.0)
    sw = float(w.sum()) + 1e-6
    cx = float((w * xx).sum() / sw)
    cy = float((w * yy).sum() / sw)
    area = float(np.count_nonzero(mask) / mask.size)
    dx = current.astype(np.float32) - base_bgr.astype(np.float32)
    # Production model uses the RGB-to-baseline difference. The MCAP difference
    # image remains available for future experiments but is not mixed into this model.
    graydiff = cv2.cvtColor(np.abs(dx).astype(np.uint8), cv2.COLOR_BGR2GRAY)
    dvals = [float(np.mean(graydiff)), float(np.std(graydiff)), float(np.percentile(graydiff, 90))]
    layer_diff = rf - bf
    ldmag = np.sqrt(layer_diff[..., 0] ** 2 + layer_diff[..., 1] ** 2)
    diff_stats = [float(np.percentile(graydiff, 50)), float(np.percentile(graydiff, 75)), float(np.count_nonzero(graydiff > 8) / graydiff.size), float(np.mean(graydiff > 20)), float(np.max(graydiff))]
    vals = rvals + bvals + [
        float(np.mean(ux)), float(np.mean(uy)), float(np.std(ux)), float(np.std(uy)),
        float(np.median(mag)), float(np.percentile(mag, 90)),
        float(np.mean(ldmag)), float(np.percentile(ldmag, 90)),
        area, cx / current.shape[1], cy / current.shape[0],
    ] + dvals + diff_stats + [float(np.mean(current)), float(np.std(current))]
    return np.asarray(vals, dtype=np.float32)


FEATURE_NAMES = (
    [f"red_{x}" for x in ("mean_ux", "mean_uy", "std_ux", "std_uy", "med_mag", "p75_mag", "p90_mag", "mean_div", "std_div", "p90_abs_div", "mean_curl", "std_curl", "p90_abs_curl")]
    + [f"blue_{x}" for x in ("mean_ux", "mean_uy", "std_ux", "std_uy", "med_mag", "p75_mag", "p90_mag", "mean_div", "std_div", "p90_abs_div", "mean_curl", "std_curl", "p90_abs_curl")]
    + ["fused_mean_ux", "fused_mean_uy", "fused_std_ux", "fused_std_uy", "fused_med_mag", "fused_p90_mag", "layer_diff_mean_mag", "layer_diff_p90_mag", "contact_area_ratio", "contact_cx_norm", "contact_cy_norm", "graydiff_mean", "graydiff_std", "graydiff_p90", "diff_p50", "diff_p75", "diff_nonzero_ratio", "diff_high_ratio", "diff_max", "image_mean", "image_std"]
)
PRODUCTION_FEATURE_NAMES = tuple(FEATURE_NAMES[i] for i in PRODUCTION_FEATURE_INDICES)

_TRIALS = None
_BASE = None
_STORE = None


def sample_quality_reasons(msg) -> list[str]:
    """Return explicit rejection causes for a labeled synchronized sample."""
    reasons: list[str] = []
    if not bool(msg.valid):
        reasons.append("sample_valid_false")
    if not bool(msg.trial.valid):
        reasons.append("trial_valid_false")
    if abs(float(msg.image_wrench_offset_ms)) > IMAGE_WRENCH_OFFSET_LIMIT_MS:
        reasons.append("image_wrench_offset")
    if abs(float(msg.image_robot_offset_ms)) > IMAGE_ROBOT_OFFSET_LIMIT_MS:
        reasons.append("image_robot_offset")
    if abs(float(msg.image_difference_offset_ms)) > IMAGE_DERIVED_OFFSET_LIMIT_MS:
        reasons.append("image_difference_offset")
    if abs(float(msg.image_deformation_offset_ms)) > IMAGE_DERIVED_OFFSET_LIMIT_MS:
        reasons.append("image_deformation_offset")
    if not len(msg.rgb.data):
        reasons.append("rgb_missing")
    return reasons


def wrench_force_vector(msg) -> np.ndarray | None:
    """Return the recorded E75 force vector, or ``None`` when it is unusable."""
    try:
        force = msg.wrench_gel.wrench.force
        values = np.asarray([force.x, force.y, force.z], dtype=np.float64)
    except (AttributeError, TypeError, ValueError):
        return None
    return values if values.shape == (3,) and np.isfinite(values).all() else None


def force_sample_quality_reasons(msg) -> list[str]:
    """Quality gate for E75 force fitting, independent of other side streams.

    ``msg.valid`` is an aggregate synchronisation flag.  It is intentionally
    not used here because a late robot/difference/deformation input can make it
    false while the RGB image and E75 wrench remain correctly synchronised.
    """
    reasons: list[str] = []
    if not bool(getattr(getattr(msg, "trial", None), "valid", False)):
        reasons.append("trial_valid_false")
    if not len(getattr(getattr(msg, "rgb", None), "data", b"")):
        reasons.append("rgb_missing")
    if wrench_force_vector(msg) is None:
        reasons.append("e75_force_non_finite")
    try:
        image_wrench_offset = float(msg.image_wrench_offset_ms)
    except (AttributeError, TypeError, ValueError):
        image_wrench_offset = float("nan")
    if not np.isfinite(image_wrench_offset) or abs(image_wrench_offset) > IMAGE_WRENCH_OFFSET_LIMIT_MS:
        reasons.append("image_wrench_offset")
    return reasons


def force_phase_family(phase: str) -> str:
    """Coarse phase label used to preserve ramp/shear/retract coverage."""
    if phase.startswith("shear_"):
        return "shear"
    return phase


def force_bin(fz_N: float) -> str:
    """Return the declared stratification bin for normal-force magnitude.

    Compression direction is recorded in the force sign, but sampling by
    ``abs(Fz)`` makes the light-touch bins robust to an installation whose
    normal-axis sign is inverted.  Five newtons belongs to the ``[5, 6)`` bin.
    """
    magnitude = abs(float(fz_N))
    if not np.isfinite(magnitude):
        raise ValueError("Fz must be finite before force binning")
    if magnitude < 5.0:
        lower = 0.25 * int(np.floor(magnitude / 0.25))
        return f"abs_fz_{lower:.2f}_{lower + 0.25:.2f}"
    lower = 5.0 + float(int(np.floor(magnitude - 5.0)))
    return f"abs_fz_{lower:.2f}_{lower + 1.0:.2f}"


def evenly_spaced_indices(length: int, count: int) -> np.ndarray:
    """Select at most ``count`` deterministic, endpoint-inclusive indices."""
    if length < 0 or count < 0:
        raise ValueError("length and count must be non-negative")
    if length == 0 or count == 0:
        return np.empty((0,), dtype=np.int64)
    if count >= length:
        return np.arange(length, dtype=np.int64)
    # ``round`` remains unique when count <= length and includes both endpoints.
    return np.rint(np.linspace(0, length - 1, num=count)).astype(np.int64)


def stratified_force_indices(
    trial_index: np.ndarray,
    phase: np.ndarray,
    force_N: np.ndarray,
    *,
    max_per_trial_bin: int = FORCE_MAX_SAMPLES_PER_TRIAL_BIN,
    precontact_per_trial: int = FORCE_PRECONTACT_SAMPLES_PER_TRIAL,
) -> np.ndarray:
    """Bound raw-frame retention while preserving each observed phase family.

    Non-precontact samples share a cap across a trial/bin.  When space allows,
    the selector reserves one representative for each observed normal-load,
    retract, and shear family before filling remaining slots evenly.  This
    prevents the common long normal-load ramp from erasing retract/shear data.
    """
    trial_index = np.asarray(trial_index)
    phase = np.asarray(phase).astype(str)
    force_N = np.asarray(force_N, dtype=np.float64)
    if trial_index.ndim != 1 or phase.ndim != 1 or force_N.ndim != 2 or force_N.shape[1] != 3:
        raise ValueError("expected trial_index/phase vectors and an Nx3 force array")
    if not (len(trial_index) == len(phase) == len(force_N)):
        raise ValueError("force stratification inputs have mismatched lengths")
    if max_per_trial_bin < 1 or precontact_per_trial < 1:
        raise ValueError("sampling caps must be positive")

    selected: list[int] = []
    for trial in np.unique(trial_index):
        trial_rows = np.flatnonzero(trial_index == trial)
        precontact = trial_rows[phase[trial_rows] == "precontact"]
        if precontact.size:
            selected.extend(precontact[evenly_spaced_indices(len(precontact), precontact_per_trial)].tolist())

        by_bin: dict[str, list[int]] = {}
        for index in trial_rows:
            if not is_force_contact_phase(phase[index]):
                continue
            by_bin.setdefault(force_bin(force_N[index, 2]), []).append(int(index))

        for indices in by_bin.values():
            # One representative per family first, in the stated physical order.
            chosen: list[int] = []
            for family in ("normal_load", "retract", "shear"):
                family_indices = [item for item in indices if force_phase_family(phase[item]) == family]
                if family_indices and len(chosen) < max_per_trial_bin:
                    chosen.append(family_indices[evenly_spaced_indices(len(family_indices), 1)[0]])
            remaining = [item for item in indices if item not in chosen]
            slots = max_per_trial_bin - len(chosen)
            if slots > 0 and remaining:
                chosen.extend(np.asarray(remaining)[evenly_spaced_indices(len(remaining), slots)].tolist())
            selected.extend(chosen)
    return np.asarray(sorted(set(selected)), dtype=np.int64)


def tared_force(raw_force_N: np.ndarray, precontact_force_N: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Apply the per-trial three-axis median E75 tare to raw force rows."""
    raw_force_N = np.asarray(raw_force_N, dtype=np.float64)
    precontact_force_N = np.asarray(precontact_force_N, dtype=np.float64)
    if raw_force_N.ndim != 2 or raw_force_N.shape[1] != 3:
        raise ValueError("raw force must be an Nx3 array")
    if precontact_force_N.ndim != 2 or precontact_force_N.shape[1] != 3 or not len(precontact_force_N):
        raise ValueError("precontact force must contain at least one Nx3 E75 row")
    if not np.isfinite(raw_force_N).all() or not np.isfinite(precontact_force_N).all():
        raise ValueError("E75 force arrays must be finite before taring")
    tare = np.median(precontact_force_N, axis=0)
    return raw_force_N - tare, tare


def is_force_contact_phase(phase: str) -> bool:
    """Whether a recorded phase can contribute a non-zero E75 force row."""
    return phase in {"normal_load", "retract"} or phase.startswith("shear_")


def contact_point_to_mm(contact_point) -> list[float]:
    """Convert the ROS geometry Point contract (metres) to UI/model millimetres."""
    return [
        1000.0 * float(contact_point.x),
        1000.0 * float(contact_point.y),
        1000.0 * float(contact_point.z),
    ]


def hold_index(phase: str) -> int:
    return {"normal_load": 0, "shear_1mm": 1, "shear_2mm": 2}[phase]


def in_stable_hold(raw_log_time: int, hold: dict) -> bool:
    """Discard entry/exit transients and use the central 70% of a hold."""
    start, end = int(hold["start_ns"]), int(hold["end_ns"])
    if not start <= raw_log_time <= end:
        return False
    fraction = (raw_log_time - start) / max(1, end - start)
    return 0.20 <= fraction <= 0.90


def _init_worker():
    global _TRIALS, _BASE, _STORE
    cv2.setNumThreads(1)
    _TRIALS = load_trials()
    _BASE = cv2.imdecode(np.fromfile(str(REFERENCE), dtype=np.uint8), cv2.IMREAD_COLOR)
    _STORE = make_store()


def _process_bag(args):
    bi, bag = args
    rows = {}
    trial_base = {}
    rejected = {}
    baseline_count = {}
    try:
        stream = bag.open("rb")
        reader = make_reader(stream)
        iterator = reader.iter_messages()
        for schema, channel, raw in iterator:
            if channel.topic != "/gel_sync/sample":
                continue
            msg = _STORE.deserialize_cdr(raw.data, schema.name)
            phase = msg.trial.phase
            ti = int(msg.trial.trial_index)
            if ti not in _TRIALS:
                continue
            key = (ti, phase)
            # Use a per-trial precontact image to remove session-to-session drift.
            if phase == "precontact":
                cur = cv2.imdecode(np.frombuffer(bytes(msg.rgb.data), dtype=np.uint8), cv2.IMREAD_COLOR)
                if cur is not None:
                    trial_base.setdefault(ti, []).append(cur)
                    baseline_count[ti] = baseline_count.get(ti, 0) + 1
                continue
            if phase not in PHASES:
                continue
            quality_reasons = sample_quality_reasons(msg)
            if quality_reasons:
                for reason in quality_reasons:
                    rejected[reason] = rejected.get(reason, 0) + 1
                continue
            win = hold_index(phase)
            hw = _TRIALS[ti].get("hold_windows", [])[win]
            if not in_stable_hold(raw.log_time, hw):
                continue
            cur = cv2.imdecode(np.frombuffer(bytes(msg.rgb.data), dtype=np.uint8), cv2.IMREAD_COLOR)
            if cur is None:
                rejected["rgb_decode_failed"] = rejected.get("rgb_decode_failed", 0) + 1
                continue
            diff = cv2.imdecode(np.frombuffer(bytes(msg.difference.data), dtype=np.uint8), cv2.IMREAD_COLOR) if len(msg.difference.data) else None
            try:
                base_images = trial_base.get(ti)
                base = np.median(np.stack(base_images), axis=0).astype(np.uint8) if base_images else _BASE
                feat = image_features(base, cur, diff)
            except cv2.error:
                rejected["feature_extraction_failed"] = rejected.get("feature_extraction_failed", 0) + 1
                continue
            rows.setdefault(key, []).append((
                feat,
                [msg.wrench_gel.wrench.force.x, msg.wrench_gel.wrench.force.y, msg.wrench_gel.wrench.force.z],
                # ROS geometry messages use metres.  The model and UI contract
                # use millimetres, so convert exactly once at ingestion.
                contact_point_to_mm(msg.contact_point_gel),
                [
                    msg.image_wrench_offset_ms,
                    msg.image_robot_offset_ms,
                    msg.image_difference_offset_ms,
                    msg.image_deformation_offset_ms,
                ],
            ))
        stream.close()
    except Exception as exc:
        # Some auxiliary recordings are intentionally truncated; retain valid rows
        # from a bag if any and report the file to the parent process.
        return bi, str(bag), np.asarray([], dtype=str), np.empty((0, len(PRODUCTION_FEATURE_NAMES)), np.float32), np.empty((0, 3), np.float32), np.empty((0, 3), np.float32), np.empty((0, 5), np.float32), np.empty((0, 4), np.float32), np.empty((0,), np.int32), rejected, f"{type(exc).__name__}: {exc}"
    keys, X, Y, C, G, O, N = [], [], [], [], [], [], []
    for ti, phase in sorted(rows):
        items = rows[(ti, phase)]
        if len(items) < MIN_SAMPLES_PER_HOLD:
            rejected["hold_too_few_strict_samples"] = rejected.get("hold_too_few_strict_samples", 0) + len(items)
            continue
        full_feature = np.median(np.stack([x[0] for x in items]), axis=0)
        X.append(full_feature[list(PRODUCTION_FEATURE_INDICES)])
        Y.append(np.median(np.asarray([x[1] for x in items], np.float32), axis=0))
        C.append(np.median(np.asarray([x[2] for x in items], np.float32), axis=0))
        O.append(np.max(np.abs(np.asarray([x[3] for x in items], np.float32)), axis=0))
        N.append(len(items))
        tr = _TRIALS[ti]
        G.append([float(tr["grid_x_mm"]), float(tr["grid_y_mm"]), float(tr["normal_depth_mm"]), float(tr["shear_direction_deg"]), float(tr["hold_windows"][hold_index(phase)]["displacement_mm"])])
        keys.append(f"{ti}:{phase}")
    return bi, str(bag), np.asarray(keys), np.asarray(X, np.float32), np.asarray(Y, np.float32), np.asarray(C, np.float32), np.asarray(G, np.float32), np.asarray(O, np.float32), np.asarray(N, np.int32), rejected, ""


def build_strict_dataset():
    t0 = time.time()
    trials = load_trials()
    # cv2.imread on this Windows build cannot open non-ASCII paths directly.
    base = cv2.imdecode(np.fromfile(str(REFERENCE), dtype=np.uint8), cv2.IMREAD_COLOR)
    if base is None:
        raise RuntimeError(f"cannot read {REFERENCE}")
    bags = sorted(ROOT.rglob("*.mcap"))
    print(f"bags={len(bags)} trials={len(trials)} base={base.shape}", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    ctx = mp.get_context("spawn")
    # 12 decode workers keeps the 32-thread CPU and external-disk pipeline busy.
    workers = min(12, len(bags), max(4, (mp.cpu_count() or 16) // 2))
    print(f"workers={workers} cpu={mp.cpu_count()}", flush=True)
    with ctx.Pool(processes=workers, initializer=_init_worker) as pool:
        for done, result in enumerate(pool.imap_unordered(_process_bag, list(enumerate(bags, 1)), chunksize=1), 1):
            results.append(result)
            status = f" error={result[10]}" if result[10] else ""
            print(f"[{done}/{len(bags)}] {Path(result[1]).name} rows={len(result[2])} elapsed={time.time()-t0:.1f}s{status}", flush=True)
    # A trial normally belongs to one MCAP; median merge also handles split segments.
    merged = {}
    provenance = {}
    rejection_counts = {}
    for bag_index, bag_path, keys0, x0, y0, c0, g0, o0, n0, rejected, _ in results:
        for reason, count in rejected.items():
            rejection_counts[reason] = rejection_counts.get(reason, 0) + int(count)
        for i, key in enumerate(keys0.tolist()):
            merged.setdefault(key, []).append((x0[i], y0[i], c0[i], g0[i], o0[i], n0[i], bag_index))
            provenance.setdefault(key, []).append(Path(bag_path).name)
    keys = sorted(merged)
    X, Y, C, G, O, N, B = [], [], [], [], [], [], []
    for key in keys:
        items = merged[key]
        X.append(np.median(np.stack([x[0] for x in items]), axis=0))
        Y.append(np.median(np.stack([x[1] for x in items]), axis=0))
        C.append(np.median(np.stack([x[2] for x in items]), axis=0))
        G.append(items[0][3])
        O.append(np.max(np.stack([x[4] for x in items]), axis=0))
        N.append(int(np.sum([x[5] for x in items])))
        B.append(int(items[0][6]))
    out = OUT / "tactile_features_strict.npz"
    np.savez_compressed(
        out,
        X=np.asarray(X, np.float32),
        force_N=np.asarray(Y, np.float32),
        contact_mm=np.asarray(C, np.float32),
        group=np.asarray(G, np.float32),
        max_abs_offsets_ms=np.asarray(O, np.float32),
        strict_sample_count=np.asarray(N, np.int32),
        bag_index=np.asarray(B, np.int32),
        feature_names=np.asarray(PRODUCTION_FEATURE_NAMES),
        keys=np.asarray(keys),
        bag_names=np.asarray([bag.name for bag in bags]),
    )
    manifest = {
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "quality_policy_version": QUALITY_POLICY_VERSION,
        "source_root": str(ROOT),
        "source_bag_count": len(bags),
        "source_trial_count": len(trials),
        "output_rows": len(X),
        "feature_dim": len(PRODUCTION_FEATURE_NAMES),
        "contact_unit": "mm",
        "force_unit": "N",
        "quality_limits_ms": {
            "image_wrench": IMAGE_WRENCH_OFFSET_LIMIT_MS,
            "image_robot": IMAGE_ROBOT_OFFSET_LIMIT_MS,
            "image_difference": IMAGE_DERIVED_OFFSET_LIMIT_MS,
            "image_deformation": IMAGE_DERIVED_OFFSET_LIMIT_MS,
        },
        "min_samples_per_hold": MIN_SAMPLES_PER_HOLD,
        "rejection_counts": rejection_counts,
        "incomplete_bags": [str(result[1]) for result in results if result[10]],
    }
    (OUT / "tactile_features_strict_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"saved={out} rows={len(X)} dims={len(PRODUCTION_FEATURE_NAMES)} elapsed={time.time()-t0:.1f}s", flush=True)


def _force_group(trial: dict, phase: str) -> list[float]:
    """Metadata retained for grouped evaluation; only x/y define the CV group."""
    displacement = {
        "normal_load": 0.0,
        "shear_1mm": 1.0,
        "shear_2mm": 2.0,
        # Retraction has no hold-window entry in the current trial manifest.
        # Preserve it as a distinct numeric diagnostic value rather than NaN.
        "retract": -1.0,
    }.get(phase, 0.0)
    return [
        float(trial["grid_x_mm"]),
        float(trial["grid_y_mm"]),
        float(trial["normal_depth_mm"]),
        float(trial["shear_direction_deg"]),
        displacement,
    ]


def _contact_vector_or_zero(msg) -> tuple[np.ndarray, bool]:
    try:
        value = np.asarray(contact_point_to_mm(msg.contact_point_gel), dtype=np.float64)
    except (AttributeError, TypeError, ValueError):
        value = np.zeros(3, dtype=np.float64)
    return (value, bool(value.shape == (3,) and np.isfinite(value).all())) if value.shape == (3,) else (np.zeros(3), False)


def _force_process_bag(args):
    """Extract bounded raw-frame force rows from one MCAP without strict side gates."""
    bag_index, bag_path = args
    bag = Path(bag_path)
    phase_inventory: Counter[str] = Counter()
    rejected: Counter[str] = Counter()
    trial_rejections: Counter[str] = Counter()
    trial_rows: dict[int, list[dict]] = {}
    output: list[dict] = []
    try:
        with bag.open("rb") as stream:
            reader = make_reader(stream)
            for schema, channel, raw in reader.iter_messages():
                if channel.topic != "/gel_sync/sample":
                    continue
                msg = _STORE.deserialize_cdr(raw.data, schema.name)
                phase = str(msg.trial.phase)
                phase_inventory[phase] += 1
                if phase != "precontact" and not is_force_contact_phase(phase):
                    continue
                trial_index = int(msg.trial.trial_index)
                if trial_index not in _TRIALS:
                    rejected["trial_not_in_valid_manifest"] += 1
                    continue
                reasons = force_sample_quality_reasons(msg)
                if reasons:
                    rejected.update(reasons)
                    continue
                raw_force = wrench_force_vector(msg)
                assert raw_force is not None  # checked by force_sample_quality_reasons
                contact, contact_valid = _contact_vector_or_zero(msg)
                trial_rows.setdefault(trial_index, []).append({
                    "phase": phase,
                    "raw_force_N": raw_force,
                    "contact_mm": contact,
                    "contact_valid": contact_valid,
                    "timestamp_ns": int(raw.log_time),
                    "image_wrench_offset_ms": float(msg.image_wrench_offset_ms),
                    "rgb": bytes(msg.rgb.data),
                })
    except Exception as exc:
        return {
            "bag_index": bag_index,
            "bag_path": str(bag),
            "rows": [],
            "phase_inventory": dict(phase_inventory),
            "rejection_counts": dict(rejected),
            "trial_rejection_counts": dict(trial_rejections),
            "error": f"{type(exc).__name__}: {exc}",
        }

    for trial_index, records in sorted(trial_rows.items()):
        precontact = [item for item in records if item["phase"] == "precontact"]
        contact_records = [item for item in records if is_force_contact_phase(item["phase"])]
        if len(precontact) < FORCE_MIN_TARE_SAMPLES:
            trial_rejections["precontact_tare_insufficient"] += 1
            continue
        if not contact_records:
            trial_rejections["no_force_phase_samples"] += 1
            continue
        raw_precontact = np.stack([item["raw_force_N"] for item in precontact])
        try:
            _, tare = tared_force(raw_precontact, raw_precontact)
        except ValueError:
            trial_rejections["precontact_tare_non_finite"] += 1
            continue

        base_indices = evenly_spaced_indices(len(precontact), FORCE_BASELINE_IMAGES_PER_TRIAL)
        base_images = []
        for index in base_indices:
            decoded = cv2.imdecode(np.frombuffer(precontact[int(index)]["rgb"], dtype=np.uint8), cv2.IMREAD_COLOR)
            if decoded is not None:
                base_images.append(decoded)
        if len(base_images) < FORCE_MIN_TARE_SAMPLES:
            trial_rejections["precontact_baseline_decode_insufficient"] += 1
            continue
        try:
            base = np.median(np.stack(base_images), axis=0).astype(np.uint8)
        except (ValueError, cv2.error):
            trial_rejections["precontact_baseline_build_failed"] += 1
            continue

        raw_force = np.stack([item["raw_force_N"] for item in records])
        force, _ = tared_force(raw_force, raw_precontact)
        selector = stratified_force_indices(
            np.full(len(records), trial_index, dtype=np.int64),
            np.asarray([item["phase"] for item in records]),
            force,
        )
        trial = _TRIALS[trial_index]
        for index in selector:
            item = records[int(index)]
            current = cv2.imdecode(np.frombuffer(item["rgb"], dtype=np.uint8), cv2.IMREAD_COLOR)
            if current is None:
                rejected["rgb_decode_failed"] += 1
                continue
            try:
                feature = image_features(base, current)[list(PRODUCTION_FEATURE_INDICES)]
            except (ValueError, cv2.error):
                rejected["feature_extraction_failed"] += 1
                continue
            tared = force[int(index)]
            phase = item["phase"]
            output.append({
                "X": feature.astype(np.float32),
                "force_N": tared.astype(np.float32),
                "raw_force_N": item["raw_force_N"].astype(np.float32),
                "tare_force_N": tare.astype(np.float32),
                "contact_mm": item["contact_mm"].astype(np.float32),
                "contact_valid": bool(item["contact_valid"]),
                "group": np.asarray(_force_group(trial, phase), dtype=np.float32),
                "trial_index": trial_index,
                "phase": phase,
                "sample_kind": "precontact_zero" if phase == "precontact" else "phase_sample",
                "force_bin": force_bin(float(tared[2])),
                "force_phase_family": force_phase_family(phase),
                "timestamp_ns": item["timestamp_ns"],
                "image_wrench_offset_ms": item["image_wrench_offset_ms"],
            })
    return {
        "bag_index": bag_index,
        "bag_path": str(bag),
        "rows": output,
        "phase_inventory": dict(phase_inventory),
        "rejection_counts": dict(rejected),
        "trial_rejection_counts": dict(trial_rejections),
        "error": "",
    }


def _stack_force_rows(rows: list[dict], bag_index: int) -> dict[str, np.ndarray]:
    """Turn a selected row list into the documented, compact NPZ contract."""
    if not rows:
        return {
            "X": np.empty((0, len(PRODUCTION_FEATURE_NAMES)), np.float32),
            "force_N": np.empty((0, 3), np.float32),
            "raw_force_N": np.empty((0, 3), np.float32),
            "tare_force_N": np.empty((0, 3), np.float32),
            "contact_mm": np.empty((0, 3), np.float32),
            "contact_valid": np.empty((0,), bool),
            "group": np.empty((0, 5), np.float32),
            "trial_index": np.empty((0,), np.int32),
            "phase": np.empty((0,), "U1"),
            "sample_kind": np.empty((0,), "U1"),
            "force_bin": np.empty((0,), "U1"),
            "force_phase_family": np.empty((0,), "U1"),
            "timestamp_ns": np.empty((0,), np.int64),
            "image_wrench_offset_ms": np.empty((0,), np.float32),
            "bag_index": np.empty((0,), np.int32),
        }
    return {
        "X": np.stack([item["X"] for item in rows]).astype(np.float32),
        "force_N": np.stack([item["force_N"] for item in rows]).astype(np.float32),
        "raw_force_N": np.stack([item["raw_force_N"] for item in rows]).astype(np.float32),
        "tare_force_N": np.stack([item["tare_force_N"] for item in rows]).astype(np.float32),
        "contact_mm": np.stack([item["contact_mm"] for item in rows]).astype(np.float32),
        "contact_valid": np.asarray([item["contact_valid"] for item in rows], dtype=bool),
        "group": np.stack([item["group"] for item in rows]).astype(np.float32),
        "trial_index": np.asarray([item["trial_index"] for item in rows], dtype=np.int32),
        "phase": np.asarray([item["phase"] for item in rows]),
        "sample_kind": np.asarray([item["sample_kind"] for item in rows]),
        "force_bin": np.asarray([item["force_bin"] for item in rows]),
        "force_phase_family": np.asarray([item["force_phase_family"] for item in rows]),
        "timestamp_ns": np.asarray([item["timestamp_ns"] for item in rows], dtype=np.int64),
        "image_wrench_offset_ms": np.asarray([item["image_wrench_offset_ms"] for item in rows], dtype=np.float32),
        "bag_index": np.full(len(rows), bag_index, dtype=np.int32),
    }


def _atomic_savez(path: Path, **arrays) -> None:
    """Only replace a dataset after NumPy has successfully written its archive."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="wb", suffix=".npz", prefix=f".{path.stem}.", dir=path.parent, delete=False) as stream:
        temp_path = Path(stream.name)
        np.savez_compressed(stream, **arrays)
    try:
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", prefix=f".{path.stem}.", dir=path.parent, delete=False, encoding="utf-8") as stream:
        temp_path = Path(stream.name)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    try:
        os.replace(temp_path, path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _file_sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def finalize_force_manifest(out: Path = OUT) -> Path:
    """Bind a completed force NPZ to its manifest without rebuilding features."""
    dataset_path = out / FORCE_DATASET_NAME
    manifest_path = out / FORCE_MANIFEST_NAME
    if not dataset_path.exists() or not manifest_path.exists():
        raise RuntimeError("force dataset and manifest must both exist before finalization")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    with np.load(dataset_path, allow_pickle=False) as dataset:
        manifest["dataset_sha256"] = _file_sha256(dataset_path)
        manifest["dataset_rows"] = int(dataset["X"].shape[0])
        manifest["dataset_feature_name_sha256"] = hashlib.sha256(
            "\n".join(dataset["feature_names"].tolist()).encode("utf-8")
        ).hexdigest()
    _atomic_json(manifest_path, manifest)
    return manifest_path


def build_force_dataset(
    out: Path = OUT,
    max_bags: int | None = None,
    workers: int | None = None,
    bag_paths: list[Path] | None = None,
) -> Path:
    """Build the E75-specific raw-frame dataset without touching strict artifacts."""
    t0 = time.time()
    trials = load_trials()
    bags = sorted(ROOT.rglob("*.mcap")) if bag_paths is None else [Path(item) for item in bag_paths]
    missing_bags = [str(item) for item in bags if not item.is_file()]
    if missing_bags:
        raise FileNotFoundError(f"requested MCAP path does not exist: {missing_bags[0]}")
    if max_bags is not None:
        if max_bags < 1:
            raise ValueError("max_bags must be at least one")
        bags = bags[:max_bags]
    if not bags:
        raise RuntimeError(f"no MCAP files found under {ROOT}")
    # Raw force rows temporarily retain compressed RGB until their per-trial
    # bins are resolved.  Cap default parallelism more conservatively than the
    # old strict-hold route so a multi-gigabyte MCAP cannot multiply into an
    # avoidable memory-pressure failure.
    worker_count = workers if workers is not None else min(4, len(bags), max(1, (mp.cpu_count() or 4) // 2))
    if worker_count < 1:
        raise ValueError("workers must be at least one")
    print(f"force-bags={len(bags)} trials={len(trials)} workers={worker_count}", flush=True)
    results = []
    if worker_count == 1:
        _init_worker()
        for index, bag in enumerate(bags, 1):
            result = _force_process_bag((index, str(bag)))
            results.append(result)
            print(f"[{index}/{len(bags)}] {bag.name} rows={len(result['rows'])} elapsed={time.time()-t0:.1f}s error={result['error']}", flush=True)
    else:
        ctx = mp.get_context("spawn")
        with ctx.Pool(processes=worker_count, initializer=_init_worker) as pool:
            for done, result in enumerate(pool.imap_unordered(_force_process_bag, [(index, str(bag)) for index, bag in enumerate(bags, 1)], chunksize=1), 1):
                results.append(result)
                print(f"[{done}/{len(bags)}] {Path(result['bag_path']).name} rows={len(result['rows'])} elapsed={time.time()-t0:.1f}s error={result['error']}", flush=True)

    # A trial normally belongs to one bag.  Apply the selector once more after
    # merge so a split recording still obeys the documented per-trial cap.
    merged_rows: list[dict] = []
    for result in results:
        for item in result["rows"]:
            item["bag_index"] = result["bag_index"]
            merged_rows.append(item)
    merged_rows.sort(key=lambda item: (item["trial_index"], item["timestamp_ns"], item["bag_index"]))
    if merged_rows:
        preliminary = _stack_force_rows(merged_rows, bag_index=0)
        keep = stratified_force_indices(
            preliminary["trial_index"], preliminary["phase"], preliminary["force_N"],
        )
        merged_rows = [merged_rows[int(index)] for index in keep]

    arrays = _stack_force_rows(merged_rows, bag_index=0)
    if merged_rows:
        arrays["bag_index"] = np.asarray([item["bag_index"] for item in merged_rows], dtype=np.int32)
    arrays["feature_names"] = np.asarray(PRODUCTION_FEATURE_NAMES)
    arrays["source_bag_names"] = np.asarray([Path(item["bag_path"]).name for item in results])
    arrays["dataset_schema_version"] = np.asarray(FORCE_DATASET_SCHEMA_VERSION)
    arrays["quality_policy_version"] = np.asarray(FORCE_QUALITY_POLICY_VERSION)

    phase_inventory: Counter[str] = Counter()
    rejection_counts: Counter[str] = Counter()
    trial_rejection_counts: Counter[str] = Counter()
    incomplete_bags = []
    for result in results:
        phase_inventory.update(result["phase_inventory"])
        rejection_counts.update(result["rejection_counts"])
        trial_rejection_counts.update(result["trial_rejection_counts"])
        if result["error"]:
            incomplete_bags.append({"path": result["bag_path"], "reason": result["error"]})

    tared = arrays["force_N"]
    raw_force = arrays["raw_force_N"]
    bin_counts = Counter(arrays["force_bin"].tolist())
    selected_phase_counts = Counter(arrays["phase"].tolist())
    sample_kind_counts = Counter(arrays["sample_kind"].tolist())
    tared_trials = np.unique(arrays["trial_index"]).tolist()
    manifest = {
        "dataset_schema_version": FORCE_DATASET_SCHEMA_VERSION,
        "feature_schema_version": FEATURE_SCHEMA_VERSION,
        "quality_policy_version": FORCE_QUALITY_POLICY_VERSION,
        "source_root": str(ROOT),
        "source_bag_count": len(bags),
        "source_trial_count": len(trials),
        "output_rows": int(len(tared)),
        "feature_dim": len(PRODUCTION_FEATURE_NAMES),
        "force_unit": "N",
        "contact_unit": "mm",
        "force_label_source": "E75-485 / gel_frame / wrench_gel",
        "force_label_tare": "per-trial median of accepted precontact E75 force rows",
        "image_wrench_offset_limit_ms": IMAGE_WRENCH_OFFSET_LIMIT_MS,
        "force_only_gate": ["trial_valid", "rgb_present", "finite_E75_force", "abs_image_wrench_offset_le_2ms"],
        "not_force_gates": ["sample_valid", "image_robot_offset", "image_difference_offset", "image_deformation_offset"],
        "sampling": {
            "abs_fz_under_5N_bin_width_N": 0.25,
            "abs_fz_at_or_over_5N_bin_width_N": 1.0,
            "max_samples_per_trial_bin": FORCE_MAX_SAMPLES_PER_TRIAL_BIN,
            "precontact_zero_samples_per_trial": FORCE_PRECONTACT_SAMPLES_PER_TRIAL,
        },
        "phase_inventory_raw": dict(sorted(phase_inventory.items())),
        "selected_phase_counts": dict(sorted(selected_phase_counts.items())),
        "sample_kind_counts": dict(sorted(sample_kind_counts.items())),
        "force_bin_counts": dict(sorted(bin_counts.items())),
        "tare": {
            "accepted_trial_count": len(tared_trials),
            "rejected_trial_counts": dict(sorted(trial_rejection_counts.items())),
            "minimum_precontact_rows": FORCE_MIN_TARE_SAMPLES,
        },
        "force_range_N": {
            "raw_min": raw_force.min(axis=0).tolist() if len(raw_force) else None,
            "raw_max": raw_force.max(axis=0).tolist() if len(raw_force) else None,
            "tared_min": tared.min(axis=0).tolist() if len(tared) else None,
            "tared_max": tared.max(axis=0).tolist() if len(tared) else None,
        },
        "image_wrench_offset_ms": {
            "p95_abs": float(np.quantile(np.abs(arrays["image_wrench_offset_ms"]), 0.95)) if len(tared) else None,
            "max_abs": float(np.max(np.abs(arrays["image_wrench_offset_ms"]))) if len(tared) else None,
        },
        "rejection_counts": dict(sorted(rejection_counts.items())),
        "incomplete_bags": incomplete_bags,
        "feature_name_sha256": hashlib.sha256("\n".join(PRODUCTION_FEATURE_NAMES).encode("utf-8")).hexdigest(),
    }
    dataset_path = out / FORCE_DATASET_NAME
    _atomic_savez(dataset_path, **arrays)
    manifest["dataset_sha256"] = _file_sha256(dataset_path)
    manifest["dataset_rows"] = int(len(tared))
    manifest["dataset_feature_name_sha256"] = manifest["feature_name_sha256"]
    _atomic_json(out / FORCE_MANIFEST_NAME, manifest)
    print(f"saved={dataset_path} rows={len(tared)} dims={len(PRODUCTION_FEATURE_NAMES)} elapsed={time.time()-t0:.1f}s", flush=True)
    return dataset_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract strict or E75 force-only tactile features from MCAP.")
    parser.add_argument("--mode", choices=("strict", "force"), default="strict")
    parser.add_argument("--out", type=Path, default=OUT, help="Artifact directory; strict mode retains its historical fixed output path.")
    parser.add_argument("--max-bags", type=int, default=None, help="Read at most this many bags (useful only for a smoke extraction).")
    parser.add_argument("--bag", type=Path, action="append", default=None, help="Explicit MCAP path; repeat for a bounded multi-position smoke extraction.")
    parser.add_argument("--workers", type=int, default=None)
    parser.add_argument("--finalize-force-manifest", action="store_true", help="Bind an existing force NPZ to its manifest by SHA-256; does not read MCAP files.")
    args = parser.parse_args()
    if args.finalize_force_manifest:
        if args.mode != "force" or args.max_bags is not None or args.workers is not None:
            raise ValueError("--finalize-force-manifest only supports the default --mode force without bag/worker options")
        print(f"finalized={finalize_force_manifest(args.out)}", flush=True)
        return
    if args.mode == "strict":
        if args.max_bags is not None or args.workers is not None or args.out != OUT:
            raise ValueError("strict mode retains the established all-bag artifact contract; use --mode force for scoped extraction")
        build_strict_dataset()
        return
    if args.bag is not None and args.max_bags is not None:
        raise ValueError("use either --bag or --max-bags, not both")
    build_force_dataset(out=args.out, max_bags=args.max_bags, workers=args.workers, bag_paths=args.bag)


if __name__ == "__main__":
    main()

