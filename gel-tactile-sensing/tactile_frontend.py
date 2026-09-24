"""Windows tactile frontend prototype.

Usage:
  python tactile_frontend.py --camera-index 1 --gpu
  python tactile_frontend.py --headless --frames 30
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
WORK = ROOT
MODEL = ROOT / "artifacts" / "tactile_model_scientific.npz"
LEGACY_MODEL = ROOT / "tactile_model_gpu.npz"
sys.path.insert(0, str(WORK))
from extract_features import PRODUCTION_FEATURE_INDICES, flow_features, score_layers  # noqa: E402


FIELD_STEP = 12
MODEL_SCHEMA = "gel-tactile-research-model/v2"
LEGACY_MODEL_SCHEMA = "gel-tactile-research-model/v1"
FIELD_X_RANGE = range(90, 316, FIELD_STEP)
FIELD_Y_RANGE = range(24, 245, FIELD_STEP)

# Farneback releases the GIL.  Keep one pair of workers alive instead of
# serialising the independent red and blue layer calculations per frame.
FLOW_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="gel-flow")


def display_value(value: float) -> str:
    value = float(value)
    return "0.00" if abs(value) < 0.005 else f"{value:+.2f}"


def prepare_frame(frame: np.ndarray) -> np.ndarray:
    h, w = frame.shape[:2]
    target_ratio = 400 / 256
    if w / h > target_ratio:
        nw = int(h * target_ratio)
        x0 = max(0, (w - nw) // 2)
        frame = frame[:, x0:x0 + nw]
    else:
        nh = int(w / target_ratio)
        y0 = max(0, (h - nh) // 2)
        frame = frame[y0:y0 + nh, :]
    return cv2.resize(frame, (400, 256), interpolation=cv2.INTER_AREA)


def _contact_centroid(
    flow: np.ndarray,
    magnitude: np.ndarray | None = None,
    threshold: float | None = None,
) -> tuple[int, int]:
    """Find a display-only contact centroid inside the calibrated gel ROI."""
    height, width = flow.shape[:2]
    if magnitude is None:
        magnitude = np.hypot(flow[..., 0], flow[..., 1])
    threshold = max(0.12, float(np.percentile(magnitude, 65))) if threshold is None else threshold
    weights = np.where(magnitude > threshold, np.maximum(magnitude - 0.12, 0.0), 0.0)
    if (width, height) == (400, 256):
        roi = np.zeros_like(weights, dtype=bool)
        roi[np.ix_(list(FIELD_Y_RANGE), list(FIELD_X_RANGE))] = True
        weights = np.where(roi, weights, 0.0)
    sw = float(weights.sum())
    if sw <= 1e-6:
        return width // 2, height // 2
    yy, xx = np.indices((height, width), dtype=np.float32)
    return (
        int(np.clip((weights * xx).sum() / sw, 0, width - 1)),
        int(np.clip((weights * yy).sum() / sw, 0, height - 1)),
    )


def _draw_flow_arrows(image: np.ndarray, flow: np.ndarray, step: int = FIELD_STEP) -> np.ndarray:
    """Draw calibrated optical-flow arrows only at the fixed gel ROI lattice."""
    canvas = image.copy()
    magnitude = np.linalg.norm(flow, axis=2)
    threshold = max(0.12, float(np.percentile(magnitude, 65)))
    height, width = magnitude.shape
    x_values = FIELD_X_RANGE if (width, height) == (400, 256) else range(step // 2, width, step)
    y_values = FIELD_Y_RANGE if (width, height) == (400, 256) else range(step // 2, height, step)
    for y in y_values:
        for x in x_values:
            u, v = flow[y, x]
            m = float(np.hypot(u, v))
            if m < threshold:
                continue
            scale = min(5.0, 8.0 / max(m, 1e-3))
            end = (int(round(x + u * scale)), int(round(y + v * scale)))
            col = (0, int(255 * (1 - min(m / 3.0, 1.0))), int(255 * min(m / 3.0, 1.0)))
            cv2.arrowedLine(canvas, (x, y), end, col, 1, cv2.LINE_AA, tipLength=0.25)
    return canvas


def _draw_contact_marker(image: np.ndarray, flow: np.ndarray) -> np.ndarray:
    """Annotate a contact only after the independent contact gate passes."""
    canvas = image.copy()
    cx, cy = _contact_centroid(flow)
    cv2.drawMarker(canvas, (cx, cy), (0, 240, 255), cv2.MARKER_CROSS, 22, 2, cv2.LINE_AA)
    cv2.circle(canvas, (cx, cy), 5, (0, 240, 255), 1, cv2.LINE_AA)
    cv2.putText(canvas, "CONTACT", (min(cx + 10, 330), max(cy - 10, 18)), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 240, 255), 1, cv2.LINE_AA)
    return canvas


def _arrow_image_prepared(cur, base, step=12, show_contact=False, show_flow=True, *, return_layers=False, base_layers=None):
    if base is None:
        empty = np.zeros((256, 400, 2), np.float32)
        result = (cur, empty, 0.0, np.zeros(len(PRODUCTION_FEATURE_INDICES), np.float32))
        if return_layers:
            return (*result, {"red_flow": empty, "blue_flow": empty, "layer_difference": empty, "local_diff": 0.0})
        return result
    if base_layers is None:
        base_layers = score_layers(base)
    r0, b0 = base_layers
    r1, b1 = score_layers(cur)
    red_future = FLOW_EXECUTOR.submit(flow_features, r0, r1, "red")
    blue_future = FLOW_EXECUTOR.submit(flow_features, b0, b1, "blue")
    rv, fr = red_future.result()
    bv, fb = blue_future.result()
    f = 0.5 * (fr + fb)
    mag = np.hypot(f[..., 0], f[..., 1])
    mag_quantiles = np.percentile(mag, [50, 65, 90])
    confidence = float(np.clip(mag_quantiles[2] / 2.0, 0.0, 1.0))
    canvas = cur.copy()
    if show_flow:
        canvas = _draw_flow_arrows(canvas, f, step)
    if show_contact:
        canvas = _draw_contact_marker(canvas, f)
    feature_result = _features_from_parts(
        cur, base, rv, bv, fr, fb, fused=f, magnitude=mag,
        magnitude_quantiles=mag_quantiles,
        return_aux=return_layers,
    )
    if return_layers:
        feat, feature_aux = feature_result
    else:
        feat, feature_aux = feature_result, {}
    result = (canvas, f, confidence, feat)
    if return_layers:
        return (*result, {"red_flow": fr, "blue_flow": fb, "layer_difference": fr - fb, **feature_aux})
    return result


def arrow_image(frame, base, step=12, show_contact=False, show_flow=True, *, return_layers=False):
    """Prepare a frame and calculate its fused red/blue optical view."""
    cur = prepare_frame(frame)
    prepared_base = prepare_frame(base) if base is not None else None
    return _arrow_image_prepared(
        cur, prepared_base, step=step, show_contact=show_contact,
        show_flow=show_flow, return_layers=return_layers,
    )


def local_contact_difference(current: np.ndarray, base: np.ndarray) -> float:
    """Compare gel ROI change with the camera background change."""
    diff = cv2.cvtColor(
        np.abs(current.astype(np.float32) - base.astype(np.float32)).astype(np.uint8),
        cv2.COLOR_BGR2GRAY,
    )
    inside = diff[20:245, 85:315]
    outside = np.concatenate(
        (diff[:, :75].ravel(), diff[:, 325:].ravel(),
         diff[:20, 75:325].ravel(), diff[245:, 75:325].ravel())
    )
    return float(inside.mean() - outside.mean())


def field_points(
    flow: np.ndarray,
    confidence: float,
    step: int = FIELD_STEP,
    magnitude: np.ndarray | None = None,
) -> list[dict]:
    """Return the fixed grid used by both the web and desktop views."""
    height, width = flow.shape[:2]
    points = []
    # The calibration ROI is the illuminated gel rectangle, not the camera wall.
    x_values = FIELD_X_RANGE if (width, height) == (400, 256) and step == FIELD_STEP else range(step // 2, width, step)
    y_values = FIELD_Y_RANGE if (width, height) == (400, 256) and step == FIELD_STEP else range(step // 2, height, step)
    magnitudes = magnitude if magnitude is not None else np.hypot(flow[..., 0], flow[..., 1])
    for y in y_values:
        for x in x_values:
            ux, uy = (float(value) for value in flow[y, x])
            local_magnitude = float(magnitudes[y, x])
            points.append({
                "x": x, "y": y, "ux": ux, "uy": uy,
                "magnitude": local_magnitude,
                "confidence": float(min(max(local_magnitude / 2.0, 0.0), 1.0) * confidence),
            })
    return points


def compact_field_points(points_or_flow, step: int = FIELD_STEP) -> list[list[float]]:
    """Encode the display field without 361 verbose JSON objects per frame."""
    points = (
        points_or_flow
        if isinstance(points_or_flow, list)
        else field_points(points_or_flow, 1.0, step)
    )
    return [
        [point["x"], point["y"], point["ux"], point["uy"], point["magnitude"]]
        for point in points
    ]


def _grid_samples(values: np.ndarray | None, points: list[dict], shape: tuple[int, int]) -> np.ndarray:
    """Sample a dense scalar/vector field at the fixed display lattice."""
    if values is None:
        return np.zeros(len(points), dtype=np.float32)
    array = np.asarray(values)
    if array.ndim == 3:
        array = np.hypot(array[..., 0], array[..., 1])
    if array.ndim != 2 or tuple(array.shape) != tuple(shape):
        raise ValueError("grid weighting field must match the optical-flow image shape")
    height, width = shape
    if not points:
        return np.empty((0,), dtype=np.float32)
    coordinates = np.asarray(
        [[point["y"], point["x"]] for point in points], dtype=np.int32,
    )
    ys = np.clip(coordinates[:, 0], 0, height - 1)
    xs = np.clip(coordinates[:, 1], 0, width - 1)
    return np.asarray(array[ys, xs], dtype=np.float32)


def _robust_noise_floor(values: np.ndarray, explicit: float | None = None) -> float:
    """Estimate a non-negative optical noise floor from the quiet bulk."""
    if explicit is not None and np.isfinite(explicit):
        return max(0.0, float(explicit))
    finite = np.asarray(values, dtype=np.float32)
    finite = finite[np.isfinite(finite)]
    if not len(finite):
        return 0.0
    median = float(np.percentile(finite, 35.0))
    mad = float(np.median(np.abs(finite - np.median(finite))))
    return max(0.0, median + 0.75 * mad)


def optical_contact_signal(
    flow_p90: float,
    local_diff: float,
    layer_diff_p90: float = 0.0,
    adaptive_thresholds: tuple[float, float] | None = None,
) -> bool:
    """Detect a visible press without depending on model confidence."""
    flow_value = float(flow_p90) if np.isfinite(flow_p90) else 0.0
    diff_value = float(local_diff) if np.isfinite(local_diff) else 0.0
    layer_value = float(layer_diff_p90) if np.isfinite(layer_diff_p90) else 0.0
    adaptive_flow = float(adaptive_thresholds[0]) if adaptive_thresholds is not None else 0.80
    adaptive_diff = float(adaptive_thresholds[1]) if adaptive_thresholds is not None else 5.50
    # The adaptive flow threshold is estimated from the quiet camera state, so
    # it remains useful when exposure/brightness difference is near zero.  A
    # strong flow response is contact even when the learned E75 classifier is
    # uncertain or the frame is outside its training domain.
    strong_flow = flow_value >= max(0.65, 0.75 * adaptive_flow)
    layer_response = layer_value >= max(0.25, 0.50 * adaptive_flow)
    background_contrast = diff_value >= max(2.0, 0.35 * adaptive_diff) and flow_value >= 0.25
    return bool(strong_flow or layer_response or background_contrast)


def pressure_grid_points(
    flow: np.ndarray,
    normal_force_n: float,
    optical_contact_detected: bool,
    step: int = FIELD_STEP,
    points: list[dict] | None = None,
    force_estimate_available: bool = True,
    contact_px: list[int] | tuple[int, int] | None = None,
    layer_difference: np.ndarray | None = None,
    noise_floor: float | dict[str, float] | None = None,
) -> dict:
    """Allocate the fitted normal force over the optical deformation grid.

    The E75 supplies total force only, not per-cell pressure truth.  This is
    therefore an explicitly labelled N/cell estimate whose sum is conserved.
    When optical contact exists but force is not quantifiable, the same grid
    remains visible as relative deformation rather than pretending it is N.
    """
    points = points if points is not None else field_points(flow, 1.0, step)
    magnitudes = np.asarray([point["magnitude"] for point in points], np.float32)
    if isinstance(noise_floor, dict):
        flow_floor_arg = noise_floor.get("flow")
        layer_floor_arg = noise_floor.get("layer")
    else:
        flow_floor_arg = noise_floor
        layer_floor_arg = noise_floor
    flow_floor = _robust_noise_floor(magnitudes, flow_floor_arg)
    layer_magnitudes = _grid_samples(layer_difference, points, flow.shape[:2])
    layer_floor = _robust_noise_floor(layer_magnitudes, layer_floor_arg) if layer_difference is not None else 0.0
    flow_excess = np.maximum(magnitudes - flow_floor, 0.0)
    layer_excess = np.maximum(layer_magnitudes - layer_floor, 0.0)
    flow_scale = max(float(np.percentile(flow_excess, 90)) if flow_excess.size else 0.0, 1e-6)
    layer_scale = max(float(np.percentile(layer_excess, 90)) if layer_excess.size else 0.0, 1e-6)
    # The fused magnitude carries the primary spatial signal.  The red/blue
    # disagreement is an independent cue for local deformation and is added
    # only after its own robust noise floor has been removed.
    weights = flow_excess * (1.0 + 0.5 * (layer_excess / layer_scale))
    weights += 0.35 * layer_excess
    weights = np.maximum(weights, 0.0).astype(np.float32)
    total = float(weights.sum())
    if optical_contact_detected and total <= 1e-8:
        # A weak, nearly uniform deformation can legitimately pass the optical
        # contact gate while all samples fall below the display threshold.  Keep
        # the view alive with a compact, conservative Gaussian at the detected
        # contact centre; if no centre is available, use the ROI centre.
        center_x, center_y = contact_px or (flow.shape[1] // 2, flow.shape[0] // 2)
        coordinates = np.asarray([[point["x"], point["y"]] for point in points], np.float32)
        distance_sq = (coordinates[:, 0] - float(center_x)) ** 2 + (coordinates[:, 1] - float(center_y)) ** 2
        sigma_sq = float(max(step, 10) ** 2)
        weights = np.exp(-0.5 * distance_sq / sigma_sq).astype(np.float32)
        total = float(weights.sum())
    try:
        normal_force_n = float(normal_force_n)
    except (TypeError, ValueError):
        normal_force_n = 0.0
    if not np.isfinite(normal_force_n):
        normal_force_n = 0.0
    if not optical_contact_detected or total <= 1e-8:
        values = np.zeros_like(weights)
        unit = "N/cell"
        force_estimate_available = False
    elif force_estimate_available and abs(normal_force_n) > 0.0:
        values = weights * (normal_force_n / total)
        unit = "N/cell"
    else:
        values = weights / float(np.max(weights)) if float(np.max(weights)) > 1e-8 else np.zeros_like(weights)
        unit = "relative deformation"
        force_estimate_available = False
    return {
        "width": int(flow.shape[1]),
        "height": int(flow.shape[0]),
        "step": int(step),
        "unit": unit,
        "estimated": True,
        "force_estimate_available": bool(force_estimate_available),
        "weighting": {
            "uses_fused_flow": True,
            "uses_layer_difference": bool(layer_difference is not None),
            "flow_noise_floor_px": float(flow_floor),
            "layer_noise_floor_px": float(layer_floor),
        },
        "points": [
            [point["x"], point["y"], float(value)]
            for point, value in zip(points, values, strict=True)
        ],
    }


def draw_field_points(
    image: np.ndarray,
    flow: np.ndarray,
    valid: bool | None = None,
    step: int = FIELD_STEP,
    *,
    contact_detected: bool | None = None,
) -> np.ndarray:
    """Legacy helper that colours points from optical contact, not OOD state.

    The Web UI renders this lattice on its own pressure canvas.  Keeping the
    helper contact-driven prevents older desktop callers from turning every
    out-of-domain contact into a grey, apparently missing signal.
    """
    canvas = image.copy()
    optical_contact = bool(contact_detected if contact_detected is not None else valid)
    for point in field_points(flow, 1.0, step):
        x, y = point["x"], point["y"]
        magnitude = point["magnitude"]
        if not optical_contact:
            color = (75, 84, 94)
        else:
            strength = min(magnitude / 2.0, 1.0)
            color = (int(255 * strength), int(220 * (1.0 - strength)), 70)
        cv2.circle(canvas, (x, y), 2, color, -1, cv2.LINE_AA)
    return canvas


def infer_frame(
    frame: np.ndarray,
    base: np.ndarray,
    model: "Model",
    min_confidence: float,
    adaptive_contact_thresholds: tuple[float, float] | None = None,
    *,
    base_layers=None,
) -> dict:
    """Run the single calibrated inference contract shared by both frontends."""
    prepared = prepare_frame(frame)
    prepared_base = prepare_frame(base)
    view, flow, confidence, feat, flow_layers = _arrow_image_prepared(
        prepared, prepared_base, step=FIELD_STEP, show_contact=False,
        show_flow=False, return_layers=True, base_layers=base_layers,
    )
    magnitude = np.hypot(flow[..., 0], flow[..., 1])
    flow_threshold = max(0.12, float(np.percentile(magnitude, 65)))
    normalized = model._normalize_features(feat)[0]
    flow_p90 = float(feat[31])
    local_diff_value = flow_layers.get("local_diff")
    local_diff = float(
        local_diff_value if local_diff_value is not None
        else local_contact_difference(prepared, prepared_base)
    )
    contact_area = float(normalized[34])
    graydiff_mean = float(normalized[37])
    detail_method = getattr(model, "ood_detail", None)
    if callable(detail_method):
        ood_detail = detail_method(feat)
        raw_ood = bool(ood_detail["is_ood"])
    else:
        raw_ood = bool(model.is_ood(feat))
        ood_detail = {"is_ood": raw_ood, "violations": []}
    raw_force, raw_contact = model.predict(feat)
    finite_prediction = bool(np.isfinite(raw_force).all() and np.isfinite(raw_contact).all())
    layer_diff_p90 = float(feat[33])
    fallback_signal_present = optical_contact_signal(
        flow_p90, local_diff, layer_diff_p90,
        adaptive_contact_thresholds,
    )
    contact_probability = model.contact_probability(feat)
    adaptive_optical_contact = False
    if adaptive_contact_thresholds is not None:
        adaptive_flow_threshold, adaptive_diff_threshold = adaptive_contact_thresholds
        adaptive_optical_contact = bool(
            flow_p90 >= float(adaptive_flow_threshold)
            and local_diff >= float(adaptive_diff_threshold)
        )
    # New E75-tared packages carry a gate trained against positive E75 Fz >
    # 0.15 N.  Keep the independent optical fallback in the OR path: a model
    # can be OOD (and therefore assign a near-zero classifier probability)
    # while the live image still contains an unambiguous contact deformation.
    classifier_contact = bool(contact_probability >= 0.5) if contact_probability is not None else False
    signal_present = bool(classifier_contact or fallback_signal_present or adaptive_optical_contact)
    # The browser renders this field in a separate transparent canvas.  Keeping
    # the JPEG as raw RGB avoids spending a full frame budget drawing hundreds
    # of arrows server-side and prevents the flow layer from sharing a canvas
    # with the force-allocation grid.
    contact_px = list(_contact_centroid(flow, magnitude, flow_threshold)) if signal_present else None
    # A quiet camera can sit outside the loaded feature quantiles because of
    # exposure drift; that is not an OOD contact event and must still read 0 N.
    ood = bool(raw_ood and signal_present)
    # Confidence controls validity, never visibility.  Once optical contact is
    # detected and the model returned finite values, expose the bounded/raw
    # estimate so an operator can see what the sensor is doing at low load.
    display_available = bool(signal_present and finite_prediction)
    clamped_force, clamped_contact, clamped = model.clamp_outputs(raw_force, raw_contact)
    force = clamped_force if display_available else np.zeros(3, np.float32)
    contact = clamped_contact if display_available else np.zeros(3, np.float32)
    bounded = bool(display_available and (raw_ood or clamped))
    low_confidence = bool(display_available and confidence < float(min_confidence))
    valid = bool(display_available and not bounded and not low_confidence)
    force_status = (
        "valid" if valid
        else (
            "bounded_ood" if bounded
            else ("low_confidence" if low_confidence
                  else ("optical_contact_unquantified" if signal_present else "no_contact"))
        )
    )
    display_points = field_points(flow, confidence, FIELD_STEP, magnitude)
    pressure_grid = pressure_grid_points(
        flow,
        force[2],
        signal_present,
        points=display_points,
        force_estimate_available=bool(display_available),
        contact_px=contact_px,
        layer_difference=flow_layers["layer_difference"],
    )
    pressure_grid["bounded"] = force_status == "bounded_ood"
    status_class = "live" if valid else ("ood" if bounded else ("low_confidence" if low_confidence else "waiting"))
    status_text = (
        "LIVE" if valid
        else ("OUT OF TRAINING DOMAIN - BOUNDED" if bounded
              else ("LOW CONFIDENCE ESTIMATE" if low_confidence
                    else ("CONTACT DETECTED - FORCE UNAVAILABLE" if signal_present else "WAITING FOR CONTACT")))
    )
    return {
        "view": view,
        "flow": flow,
        "field": {"width": int(flow.shape[1]), "height": int(flow.shape[0]), "step": FIELD_STEP, "points": compact_field_points(display_points)},
        "pressure_grid": pressure_grid,
        "contact_px": contact_px,
        "force": force,
        "contact": contact,
        "confidence": float(confidence),
        "valid": valid,
        "measurement_valid": valid,
        "force_status": force_status,
        "contact_detected": bool(signal_present),
        "ood": ood,
        "status_class": status_class,
        "status_text": status_text,
        "diagnostics": {
            "raw_confidence": float(confidence), "flow_p90": flow_p90,
            "layer_diff_p90": layer_diff_p90,
            "contact_area": contact_area, "graydiff_mean": graydiff_mean,
            "local_diff": local_diff, "signal_present": signal_present,
            "fallback_signal_present": fallback_signal_present,
            "classifier_contact": classifier_contact,
            "contact_probability": contact_probability,
            "contact_gate_available": model.contact_gate_available,
            "adaptive_optical_contact": adaptive_optical_contact,
            "adaptive_contact_thresholds": list(adaptive_contact_thresholds) if adaptive_contact_thresholds else None,
            "finite_prediction": finite_prediction,
            "force_estimate_available": display_available,
            "confidence_limited": low_confidence,
            "raw_ood": raw_ood,
            "ood_detail": ood_detail,
            "raw_force_N": [float(value) for value in raw_force],
            "raw_contact_mm": [float(value) for value in raw_contact],
            "clamped": clamped,
            "pressure_weighting": pressure_grid.get("weighting"),
        },
    }


def sanitize_output(force, contact, confidence, min_confidence):
    valid = float(confidence) >= float(min_confidence)
    saturated = False
    if not valid:
        return np.zeros(3, np.float32), np.zeros(3, np.float32), False, False
    raw_force, raw_contact = np.asarray(force, np.float32), np.asarray(contact, np.float32)
    force = np.clip(raw_force, [-10.0, -10.0, -2.0], [10.0, 10.0, 30.0])
    contact = np.clip(raw_contact, [-15.0, -20.0, -3.0], [15.0, 20.0, 3.0])
    saturated = bool(np.any(np.abs(raw_force - force) > 1e-4) or np.any(np.abs(raw_contact - contact) > 1e-4))
    return force, contact, True, saturated


class Model:
    def __init__(self, path=MODEL, use_gpu=False, *, allow_legacy=False, validate_training_dataset=False):
        if not Path(path).exists() and path == MODEL:
            path = LEGACY_MODEL
        # Copy the NPZ arrays eagerly and close the ZipFile immediately.  This
        # avoids a locked model file on Windows during atomic model replacement.
        with np.load(path, allow_pickle=False) as package:
            d = {name: package[name] for name in package.files}
        self.path = str(path)
        with Path(path).open("rb") as stream:
            self.package_sha256 = hashlib.file_digest(stream, "sha256").hexdigest()
        self.schema = str(np.asarray(d["model_schema_version"]).item()) if "model_schema_version" in d else "legacy-gpu/v1"
        self.legacy_compatibility = bool(self.schema == LEGACY_MODEL_SCHEMA and allow_legacy)
        self.production = bool(self.schema == MODEL_SCHEMA or self.legacy_compatibility)
        if not self.production:
            raise ValueError(f"unsupported model schema: {self.schema}")
        self.contract_version = "v2" if self.schema == MODEL_SCHEMA else "legacy-v1"
        self.training_dataset_binding_verified = False
        if self.schema == MODEL_SCHEMA:
            self._validate_v2_contract(d, validate_training_dataset)
        self.xmean = d["scaler_mean"].astype(np.float32)
        self.xscale = np.maximum(d["scaler_scale"].astype(np.float32), 1e-6)
        self.ymean = d["y_mean"].astype(np.float32)
        self.yscale = d["y_scale"].astype(np.float32)
        self.ridge = d["ridge_weight"].astype(np.float32)
        self.powers = d["poly_powers"].astype(np.int32)
        self.cmean = d["contact_mean"].astype(np.float32)
        self.cscale = np.maximum(d["contact_scale"].astype(np.float32), 1e-6)
        self.cridge = d["contact_ridge_weight"].astype(np.float32)
        self.cpowers = d["contact_poly_powers"].astype(np.int32)
        if self.xmean.shape != (42,) or self.ridge.shape[1] != 3:
            raise ValueError("calibrated model contract requires 42 features and three force axes")
        if "feature_names" in d and len(d["feature_names"]) != 42:
            raise ValueError("calibrated model feature contract is not 42-dimensional")
        self.feature_names = tuple(
            str(name) for name in d.get("feature_names", np.asarray([f"feature_{i}" for i in range(42)]))
        )
        self.mlp_layer_count = int(np.asarray(d["mlp_layer_count"]).item()) if "mlp_layer_count" in d else 0
        if not self.mlp_layer_count and "mlp_w0" in d:
            self.mlp_layer_count = len([name for name in d if name.startswith("mlp_w")])
        self.mw = [d[f"mlp_w{i}"].astype(np.float32) for i in range(self.mlp_layer_count)]
        self.mb = [d[f"mlp_b{i}"].astype(np.float32) for i in range(self.mlp_layer_count)]
        self.mlp_activation = str(np.asarray(d["mlp_activation"]).item()) if "mlp_activation" in d else "relu"
        self.mlp_xmean = d["mlp_scaler_mean"].astype(np.float32) if "mlp_scaler_mean" in d else self.xmean
        self.mlp_xscale = np.maximum(
            d["mlp_scaler_scale"].astype(np.float32) if "mlp_scaler_scale" in d else self.xscale,
            1e-6,
        )
        self.mlp_ymean = d["mlp_y_mean"].astype(np.float32) if "mlp_y_mean" in d else self.ymean
        self.mlp_yscale = np.maximum(
            d["mlp_y_scale"].astype(np.float32) if "mlp_y_scale" in d else self.yscale,
            1e-6,
        )
        self.huber_weight = d["huber_weight"].astype(np.float32) if "huber_weight" in d else None
        self.huber_intercept = d["huber_intercept"].astype(np.float32) if "huber_intercept" in d else None
        self.contact_gate_available = bool(np.asarray(d["contact_gate_available"]).item()) if "contact_gate_available" in d else False
        self.contact_gate_xmean = d["contact_gate_x_mean"].astype(np.float32) if "contact_gate_x_mean" in d else None
        self.contact_gate_xscale = np.maximum(d["contact_gate_x_scale"].astype(np.float32), 1e-6) if "contact_gate_x_scale" in d else None
        self.contact_gate_weight = d["contact_gate_weight"].astype(np.float32) if "contact_gate_weight" in d else None
        self.contact_gate_bias = float(np.asarray(d["contact_gate_bias"]).item()) if "contact_gate_bias" in d else None
        if self.contact_gate_available and any(
            value is None for value in (
                self.contact_gate_xmean, self.contact_gate_xscale,
                self.contact_gate_weight, self.contact_gate_bias,
            )
        ):
            raise ValueError("contact gate is marked available but its coefficients are missing")
        self.ood_lower = d["feature_ood_lower"].astype(np.float32) if "feature_ood_lower" in d else None
        self.ood_upper = d["feature_ood_upper"].astype(np.float32) if "feature_ood_upper" in d else None
        self.force_lower, self.force_upper = self._output_bounds(
            d, "force_bounds_lower_N", "force_bounds_upper_N", "force_N", self.ymean, self.yscale,
        )
        self.contact_lower, self.contact_upper = self._output_bounds(
            d, "contact_bounds_lower_mm", "contact_bounds_upper_mm", "contact_mm", self.cmean, self.cscale,
        )
        self.use_gpu = bool(use_gpu)
        self.runtime_model_kind = str(np.asarray(d["runtime_model_kind"]).item()) if "runtime_model_kind" in d else "ridge_quadratic"
        self.training_dataset_schema = str(np.asarray(d["training_dataset_schema"]).item()) if "training_dataset_schema" in d else "legacy-strict/v1"
        self.training_dataset_sha256 = str(np.asarray(d["training_dataset_sha256"]).item()) if "training_dataset_sha256" in d else ""
        if self.runtime_model_kind not in {"ridge_quadratic", "huber_linear", "mlp_small"}:
            raise ValueError(f"unsupported runtime force model: {self.runtime_model_kind}")
        if self.runtime_model_kind == "huber_linear" and (
            self.huber_weight is None or self.huber_intercept is None
        ):
            raise ValueError("huber runtime model is missing coefficients")
        if self.runtime_model_kind == "mlp_small" and not self.mw:
            raise ValueError("mlp runtime model is missing layer weights")
        self.reference_label_sensor = str(np.asarray(d["reference_label_sensor"]).item()) if "reference_label_sensor" in d else "E75-485 / gel_frame / wrench_gel"
        self.runtime_backend = "CPU FARNEBACK / 2 WORKERS"
        self.cp = None
        if self.use_gpu and not self.production:
            import cupy as cp
            self.cp = cp
            self.gxmean, self.gxscale = cp.asarray(self.xmean), cp.asarray(self.xscale)
            self.gymean, self.gyscale = cp.asarray(self.ymean), cp.asarray(self.yscale)
            self.gridge = cp.asarray(self.ridge)
            self.gpowers = cp.asarray(self.powers)
            self.gcmean, self.gcscale = cp.asarray(self.cmean), cp.asarray(self.cscale)
            self.gcridge, self.gcpowers = cp.asarray(self.cridge), cp.asarray(self.cpowers)
            self.gmw = [cp.asarray(x) for x in self.mw]; self.gmb = [cp.asarray(x) for x in self.mb]

    def _output_bounds(self, package, lower_key, upper_key, dataset_key, mean, scale):
        if lower_key in package and upper_key in package:
            return package[lower_key].astype(np.float32), package[upper_key].astype(np.float32)
        if not self.legacy_compatibility:
            raise ValueError(f"v2 model package is missing embedded {lower_key}/{upper_key}")
        # Explicit legacy compatibility never reads the new E75 dataset.  That
        # prevents an old model's coefficients from silently inheriting its
        # bounds after a force-only retraining run.
        for dataset_name in ("tactile_features_strict.npz",):
            candidate = Path(self.path).parent / dataset_name
            if not candidate.exists():
                continue
            try:
                values = np.load(candidate, allow_pickle=False)[dataset_key].astype(np.float32)
                if values.ndim == 2 and values.shape[1] == 3 and np.isfinite(values).all():
                    return values.min(axis=0), values.max(axis=0)
            except (KeyError, OSError, ValueError):
                continue
        spread = np.maximum(np.asarray(scale, np.float32) * 4.0, 0.1)
        return np.asarray(mean, np.float32) - spread, np.asarray(mean, np.float32) + spread

    def _validate_v2_contract(self, package, validate_training_dataset: bool) -> None:
        required = {
            "feature_names", "feature_name_sha256", "runtime_model_kind",
            "force_bounds_lower_N", "force_bounds_upper_N",
            "contact_bounds_lower_mm", "contact_bounds_upper_mm",
            "training_dataset_schema", "training_dataset_sha256",
            "contact_gate_available", "force_bound_policy",
        }
        missing = sorted(required - set(package))
        if missing:
            raise ValueError(f"v2 model package is missing required fields: {missing}")
        feature_hash = hashlib.sha256(
            "\n".join(package["feature_names"].tolist()).encode("utf-8")
        ).hexdigest()
        if str(np.asarray(package["feature_name_sha256"]).item()) != feature_hash:
            raise ValueError("v2 model package feature-name hash does not match its feature names")
        dataset_schema = str(np.asarray(package["training_dataset_schema"]).item())
        dataset_hash = str(np.asarray(package["training_dataset_sha256"]).item())
        if dataset_schema != "gel-force-e75-frame/v1":
            raise ValueError(f"v2 model requires the E75 force dataset schema, got {dataset_schema}")
        if len(dataset_hash) != 64 or any(character not in "0123456789abcdef" for character in dataset_hash.lower()):
            raise ValueError("v2 model training-dataset SHA-256 is invalid")
        if validate_training_dataset:
            dataset_path = Path(self.path).parent / "tactile_features_force.npz"
            if not dataset_path.exists():
                raise ValueError("v2 model requires its local tactile_features_force.npz for binding validation")
            with dataset_path.open("rb") as stream:
                actual_hash = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual_hash != dataset_hash:
                raise ValueError("v2 model training-dataset SHA-256 does not match tactile_features_force.npz")
            self.training_dataset_binding_verified = True

    def _normalize_features(self, feat):
        x = np.asarray(feat, np.float32).reshape(1, -1)
        if x.shape[1] == 47:
            x = x[:, list(PRODUCTION_FEATURE_INDICES)]
        if x.shape[1] != self.xmean.shape[0]:
            raise ValueError(f"feature dimension {x.shape[1]} does not match model {self.xmean.shape[0]}")
        return x

    def is_ood(self, feat, margin=0.10):
        return bool(self.ood_detail(feat, margin)["is_ood"])

    def ood_detail(self, feat, margin=0.10, limit=6):
        """Explain which calibrated feature intervals a frame violates."""
        if self.ood_lower is None or self.ood_upper is None:
            return {"is_ood": False, "violations": []}
        x = self._normalize_features(feat)[0]
        span = np.maximum(self.ood_upper - self.ood_lower, 1e-6)
        lower_allowed = self.ood_lower - margin * span
        upper_allowed = self.ood_upper + margin * span
        lower_excess = np.maximum(lower_allowed - x, 0.0) / span
        upper_excess = np.maximum(x - upper_allowed, 0.0) / span
        excess = np.maximum(lower_excess, upper_excess)
        violations = []
        for index in np.argsort(excess)[::-1][:limit]:
            if excess[index] <= 0.0:
                break
            violations.append({
                "feature": self.feature_names[int(index)],
                "index": int(index),
                "value": float(x[index]),
                "allowed_lower": float(lower_allowed[index]),
                "allowed_upper": float(upper_allowed[index]),
                "excess_span": float(excess[index]),
            })
        return {"is_ood": bool(violations), "violations": violations}

    def contact_probability(self, feat):
        """Return E75-trained contact probability or ``None`` for legacy packs."""
        if not self.contact_gate_available:
            return None
        x = self._normalize_features(feat)[0]
        score = float(
            np.dot((x - self.contact_gate_xmean) / self.contact_gate_xscale, self.contact_gate_weight)
            + self.contact_gate_bias
        )
        # Numerically stable sigmoid without importing another runtime.
        if score >= 0:
            return float(1.0 / (1.0 + np.exp(-score)))
        positive = float(np.exp(score))
        return float(positive / (1.0 + positive))

    @staticmethod
    def poly(x, powers):
        return np.prod(np.power(x[:, None, :], powers[None, :, :]), axis=2).astype(np.float32)

    def predict(self, feat):
        x = self._normalize_features(feat)
        if self.production:
            xs = (x - self.xmean) / self.xscale
            if self.runtime_model_kind == "ridge_quadratic":
                force = (self.poly(xs, self.powers) @ self.ridge) * self.yscale + self.ymean
            elif self.runtime_model_kind == "huber_linear":
                force = xs @ self.huber_weight + self.huber_intercept
            else:
                force = (x - self.mlp_xmean) / self.mlp_xscale
                for index, (weight, bias) in enumerate(zip(self.mw, self.mb, strict=True)):
                    force = force @ weight + bias
                    if index < len(self.mw) - 1:
                        if self.mlp_activation != "relu":
                            raise ValueError(f"unsupported MLP activation: {self.mlp_activation}")
                        force = np.maximum(force, 0.0)
                force = force * self.mlp_yscale + self.mlp_ymean
            contact = (self.poly(xs, self.cpowers) @ self.cridge) * self.cscale + self.cmean
            return force[0], contact[0]
        if self.cp is None:
            xs = (x - self.xmean) / self.xscale
            xp = self.poly(xs, self.powers)
            ridge = xp @ self.ridge
            a = xs
            for i, (w, b) in enumerate(zip(self.mw, self.mb)):
                a = a @ w + b
                if i < len(self.mw) - 1:
                    a = np.maximum(a, 0)
            mlp = a * self.yscale + self.ymean
            force = ridge * self.yscale + self.ymean
            force[0, 2] = mlp[0, 2]
            cpv = self.poly(xs, self.cpowers) @ self.cridge
            contact = cpv * self.cscale + self.cmean
            return force[0], contact[0]
        cp = self.cp
        xs = (cp.asarray(x) - self.gxmean) / self.gxscale
        xp = cp.prod(cp.power(xs[:, None, :], self.gpowers[None, :, :]), axis=2)
        ridge = xp @ self.gridge
        a = xs
        for i, (w, b) in enumerate(zip(self.gmw, self.gmb)):
            a = a @ w + b
            if i < len(self.gmw) - 1: a = cp.maximum(a, 0)
        mlp = a * self.gyscale + self.gymean
        force = ridge * self.gyscale + self.gymean
        force[0, 2] = mlp[0, 2]
        cpx = cp.prod(cp.power(xs[:, None, :], self.gcpowers[None, :, :]), axis=2)
        contact = cpx @ self.gcridge
        contact = contact * self.gcscale + self.gcmean
        return cp.asnumpy(force[0]), cp.asnumpy(contact[0])

    def clamp_outputs(self, force, contact):
        raw_force = np.asarray(force, np.float32)
        raw_contact = np.asarray(contact, np.float32)
        force = np.clip(raw_force, self.force_lower, self.force_upper)
        contact = np.clip(raw_contact, self.contact_lower, self.contact_upper)
        changed = bool(
            np.any(np.abs(raw_force - force) > 1e-5)
            or np.any(np.abs(raw_contact - contact) > 1e-5)
        )
        return force.astype(np.float32), contact.astype(np.float32), changed


def run_headless(args):
    cap = cv2.VideoCapture(args.camera_index, cv2.CAP_DSHOW)
    if not cap.isOpened():
        raise RuntimeError(f"camera {args.camera_index} cannot be opened")
    model = Model(use_gpu=args.gpu)
    base_frames = []
    base = None
    outputs = []
    for i in range(args.frames):
        ok, frame = cap.read()
        if not ok: continue
        if i < args.baseline_frames:
            base_frames.append(prepare_frame(frame))
            continue
        if base is None:
            base = np.median(np.stack(base_frames), axis=0).astype(np.uint8)
        result = infer_frame(frame, base, model, args.min_confidence)
        outputs.append((result["force"], result["contact"], result["confidence"]))
    cap.release()
    if not outputs:
        raise RuntimeError("no frames processed")
    f = np.median(np.stack([x[0] for x in outputs]), axis=0)
    c = np.median(np.stack([x[1] for x in outputs]), axis=0)
    print({
        "gpu_requested": bool(args.gpu),
        "backend": model.runtime_backend,
        "frames": len(outputs),
        "force_N": f.tolist(),
        "contact_mm": c.tolist(),
        "confidence": float(np.median([x[2] for x in outputs])),
    })


def _features_from_flow(frame, base):
    cur = prepare_frame(frame)
    b = prepare_frame(base)
    r0, bl0 = score_layers(b); r1, bl1 = score_layers(cur)
    rv, rf = flow_features(r0, r1, "red"); bv, bf = flow_features(bl0, bl1, "blue")
    return _features_from_parts(cur, b, rv, bv, rf, bf)


def _features_from_parts(
    cur,
    b,
    rv,
    bv,
    rf,
    bf,
    fused=None,
    magnitude=None,
    magnitude_quantiles=None,
    *,
    return_aux=False,
):
    fused = 0.5 * (rf + bf) if fused is None else fused
    mag = np.hypot(fused[..., 0], fused[..., 1]) if magnitude is None else magnitude
    yy, xx = np.mgrid[:256, :400]
    mag_quantiles = (
        np.percentile(mag, [50, 65, 90])
        if magnitude_quantiles is None else magnitude_quantiles
    )
    mask = mag > max(0.12, float(mag_quantiles[1]))
    w = np.where(mask, np.maximum(mag - 0.12, 0), 0)
    sw = float(w.sum()) + 1e-6
    layer = rf - bf
    dx = cur.astype(np.float32) - b.astype(np.float32)
    gd = cv2.cvtColor(np.abs(dx).astype(np.uint8), cv2.COLOR_BGR2GRAY)
    layer_mag = np.hypot(layer[..., 0], layer[..., 1])
    gray_quantiles = np.percentile(gd, [50, 75, 90])
    vals = rv + bv + [float(np.mean(fused[...,0])), float(np.mean(fused[...,1])), float(np.std(fused[...,0])), float(np.std(fused[...,1])), float(mag_quantiles[0]), float(mag_quantiles[2]), float(np.mean(layer_mag)), float(np.percentile(layer_mag,90)), float(np.count_nonzero(mask)/mask.size), float((w*xx).sum()/sw/400), float((w*yy).sum()/sw/256), float(gd.mean()), float(gd.std()), float(gray_quantiles[2]), float(gray_quantiles[0]), float(gray_quantiles[1]), float(np.count_nonzero(gd > 8)/gd.size), float(np.mean(gd > 20)), float(np.max(gd)), float(cur.mean()), float(cur.std())]
    features = np.asarray(vals, np.float32)
    if not return_aux:
        return features
    inside = gd[20:245, 85:315]
    outside = np.concatenate(
        (gd[:, :75].ravel(), gd[:, 325:].ravel(),
         gd[:20, 75:325].ravel(), gd[245:, 75:325].ravel())
    )
    return features, {"local_diff": float(inside.mean() - outside.mean())}


def run_gui(args):
    import tkinter as tk
    from PIL import Image, ImageTk

    cap = cv2.VideoCapture(args.camera_index, cv2.CAP_DSHOW)
    if not cap.isOpened(): raise RuntimeError(f"camera {args.camera_index} cannot be opened")
    model = Model(use_gpu=args.gpu)
    state = {"base": None, "frames": [], "running": True, "last": time.perf_counter(), "fps": 0.0, "history": [[], [], []]}
    root = tk.Tk(); root.title("Gel Tactile / Live Analysis"); root.geometry("1500x900"); root.minsize(1180, 760); root.configure(bg="#080d13")
    C = {"bg":"#080d13", "surface":"#101822", "surface2":"#151f2b", "muted":"#8190a0", "text":"#eef3f7", "green":"#63d6a2", "yellow":"#e5bd57", "blue":"#5bbdff", "violet":"#aa91ff", "orange":"#f2b667"}
    def label(parent, text, fg=C["muted"], size=9, bold=False, **kw):
        return tk.Label(parent, text=text, bg=kw.pop("bg", parent.cget("bg")), fg=fg, font=("Segoe UI", size, "bold" if bold else "normal"), **kw)
    header = tk.Frame(root, bg=C["surface"], height=72); header.pack(fill="x"); header.pack_propagate(False)
    brand = tk.Frame(header, bg=C["surface"]); brand.pack(side="left", padx=24)
    label(brand, "GEL / TACTILE", C["text"], 19, True).pack(side="left", pady=20)
    label(brand, "  LIVE ANALYSIS", C["green"], 10, True).pack(side="left", pady=23)
    meta = tk.Frame(header, bg=C["surface"]); meta.pack(side="right", padx=24)
    label(meta, "G-01", C["text"], 10, True).pack(side="left", padx=10, pady=19)
    label(meta, "UVC 640 x 480  /  31 FPS", C["muted"], 10).pack(side="left", pady=19)
    toolbar = tk.Frame(root, bg="#0d141d", height=48); toolbar.pack(fill="x"); toolbar.pack_propagate(False)
    status = label(toolbar, "  CONNECTING", C["green"], 9, True, bg="#173327", padx=12, pady=6); status.pack(side="left", padx=22, pady=8)
    label(toolbar, "ROI  400 x 256", C["muted"], 9, True).pack(side="left", padx=14)
    label(toolbar, model.runtime_backend, C["yellow"], 9, True).pack(side="right", padx=22)
    body = tk.Frame(root, bg=C["bg"]); body.pack(fill="both", expand=True, padx=20, pady=18)
    left = tk.Frame(body, bg=C["surface"]); left.pack(side="left", fill="both", expand=True, padx=(0, 16))
    left_head = tk.Frame(left, bg=C["surface"], height=48); left_head.pack(fill="x"); left_head.pack_propagate(False)
    label(left_head, "OPTICAL FIELD", C["text"], 10, True).pack(side="left", padx=18, pady=16)
    label(left_head, "RED + BLUE LAYERS", C["muted"], 9, True).pack(side="right", padx=18, pady=16)
    image_label = tk.Label(left, bg="#05080c"); image_label.pack(fill="both", expand=True, padx=16, pady=(0, 12))
    axis = tk.Canvas(left, height=94, bg=C["surface"], highlightthickness=0); axis.pack(fill="x", padx=16, pady=(0, 14))
    axis.create_text(18, 18, text="FORCE VECTOR", fill=C["muted"], anchor="w", font=("Segoe UI", 9, "bold"))
    axis.create_text(18, 38, text="XY SHEAR / NORMAL", fill="#556575", anchor="w", font=("Segoe UI", 8))
    axis.create_line(160, 66, 270, 66, fill="#405363", width=2); axis.create_line(215, 30, 215, 84, fill="#405363", width=2)
    axis.create_text(278, 66, text="+Fx", fill=C["blue"], anchor="w", font=("Segoe UI", 8, "bold")); axis.create_text(215, 24, text="+Fy", fill=C["violet"], anchor="s", font=("Segoe UI", 8, "bold"))
    vector_line = axis.create_line(215, 66, 215, 66, fill=C["yellow"], width=4, arrow=tk.LAST); axis.create_oval(207, 58, 223, 74, fill=C["yellow"], outline="")
    right = tk.Frame(body, bg=C["surface"], width=390); right.pack(side="right", fill="y"); right.pack_propagate(False)
    label(right, "FITTED FORCE", C["text"], 10, True).pack(anchor="w", padx=18, pady=(18, 2))
    label(right, "research model output  /  N", C["muted"], 9).pack(anchor="w", padx=18, pady=(0, 12))
    values = {}; cards = tk.Frame(right, bg=C["surface"]); cards.pack(fill="x", padx=14)
    for key, accent, desc in [("Fx", C["blue"], "shear x"), ("Fy", C["violet"], "shear y"), ("Fz", C["orange"], "normal")]:
        card = tk.Frame(cards, bg=C["surface2"], height=72); card.pack(fill="x", pady=4); card.pack_propagate(False)
        tk.Frame(card, bg=accent, width=4).pack(side="left", fill="y")
        label(card, key, C["text"], 13, True, bg=C["surface2"]).pack(side="left", padx=14)
        label(card, desc.upper(), C["muted"], 8, True, bg=C["surface2"]).pack(side="left")
        v = label(card, "--", C["text"], 22, True, bg=C["surface2"]); v.pack(side="right", padx=14); values[key] = v
    label(right, "CONTACT POINT", C["text"], 10, True).pack(anchor="w", padx=18, pady=(18, 3))
    contact_box = tk.Frame(right, bg=C["surface2"]); contact_box.pack(fill="x", padx=14)
    for key in ["X", "Y", "Z"]:
        v = label(contact_box, f"{key}\n--", C["text"], 10, True, bg=C["surface2"], justify="center"); v.pack(side="left", expand=True, pady=10); values["Contact "+key] = v
    chart = tk.Canvas(right, height=164, bg=C["surface"], highlightthickness=0); chart.pack(fill="x", padx=14, pady=(17, 0))
    chart.create_text(4, 4, text="FORCE HISTORY  /  80 SAMPLES", fill=C["muted"], anchor="nw", font=("Segoe UI", 8, "bold"))
    label(right, "MODEL CONFIDENCE", C["text"], 10, True).pack(anchor="w", padx=18, pady=(14, 3))
    confidence = label(right, "--", C["green"], 17, True, bg=C["surface2"]); confidence.pack(fill="x", padx=14, ipady=8)
    accuracy = tk.Frame(right, bg="#17251f"); accuracy.pack(fill="x", padx=14, pady=(12, 0))
    label(accuracy, "CALIBRATION MODEL  /  RUNTIME CONTRACT", C["green"], 8, True, bg="#17251f").pack(anchor="w", padx=12, pady=(9, 3))
    label(accuracy, "42 calibrated optical-flow features  /  Fx Fy Fz", C["text"], 8, bg="#17251f").pack(anchor="w", padx=12)
    label(accuracy, "E75 labels  /  research validation only", C["muted"], 8, bg="#17251f").pack(anchor="w", padx=12, pady=(2, 9))
    label(right, "RESEARCH USE ONLY - ABSOLUTE ACCURACY NOT RELEASED", C["yellow"], 8, True).pack(anchor="w", padx=18, pady=(12, 4))
    def reset(): state["base"] = None; state["frames"] = []; status.config(text="  CALIBRATING ZERO", bg="#3b321c", fg="#f3c66e")
    tk.Button(right, text="Recalibrate zero", command=reset, bg="#263545", fg=C["text"], activebackground="#33485d", activeforeground=C["text"], relief="flat", padx=12, pady=7).pack(anchor="w", padx=14, pady=(2, 14))
    def show_frame(frame):
        target_w = max(320, image_label.winfo_width())
        target_h = max(220, image_label.winfo_height())
        scale = min(target_w / 400.0, target_h / 256.0)
        size = (max(1, int(400 * scale)), max(1, int(256 * scale)))
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        photo = ImageTk.PhotoImage(Image.fromarray(rgb).resize(size, Image.Resampling.NEAREST))
        image_label.configure(image=photo); image_label.image = photo
    def tick():
        ok, frame = cap.read()
        if not ok: root.after(30,tick); return
        prep=prepare_frame(frame)
        if state["base"] is None:
            state["frames"].append(prep)
            if len(state["frames"]) >= args.baseline_frames:
                state["base"] = np.median(np.stack(state["frames"]),axis=0).astype(np.uint8); status.config(text="Live")
            else: status.config(text=f"Collecting baseline {len(state['frames'])}/{args.baseline_frames}")
            show_frame(prep)
            root.after(10,tick); return
        result = infer_frame(frame, state["base"], model, args.min_confidence)
        vis = result["view"]
        if result["contact_detected"]:
            vis = _draw_flow_arrows(vis, result["flow"], FIELD_STEP)
            vis = _draw_contact_marker(vis, result["flow"])
        # The Web UI owns the separate pressure-grid panel.  Keep this legacy
        # desktop view optical-only so it cannot reintroduce a grey point-grid
        # overlay whose colour is coupled to force-model validity.
        conf = result["confidence"]
        force, contact, valid = result["force"], result["contact"], result["valid"]
        saturated = False
        now=time.perf_counter(); state["fps"]=0.9*state["fps"]+0.1/(now-state["last"]); state["last"]=now
        status.config(text=("  OUT OF TRAINING DOMAIN" if result["ood"] else ("  LIVE" if valid else "  WAITING FOR CONTACT")), bg=("#4a2e20" if result["ood"] else ("#183528" if valid else "#332b1d")), fg=("#ffbd78" if result["ood"] else ("#75e0ae" if valid else "#e4b86a")))
        values["Fx"].config(text=display_value(force[0])); values["Fy"].config(text=display_value(force[1])); values["Fz"].config(text=display_value(force[2]))
        values["Contact X"].config(text=f"X\n{display_value(contact[0])}"); values["Contact Y"].config(text=f"Y\n{display_value(contact[1])}"); values["Contact Z"].config(text=f"Z\n{display_value(contact[2])}"); confidence.config(text=f"{conf:.2f}    /    {state['fps']:.1f} FPS")
        vx = float(np.clip(force[0] * 7.0, -48, 48)); vy = float(np.clip(force[1] * 7.0, -34, 34)); axis.coords(vector_line, 215, 66, 215 + vx, 66 - vy)
        for i in range(3): state["history"][i].append(float(force[i])); state["history"][i]=state["history"][i][-80:]
        chart.delete("line")
        colors=["#55b9ff","#b58cff","#f0b35b"]
        for i,hist in enumerate(state["history"]):
            if len(hist)<2: continue
            pts=[]; scale=max(2.0,max(abs(v) for v in hist)); width=max(1, chart.winfo_width()-18)
            for j,v in enumerate(hist): pts += [8+j*max(1,width/79), 88-v/scale*54]
            chart.create_line(*pts, fill=colors[i], width=2, smooth=True, tags="line")
        show_frame(vis); root.after(10,tick)
    def close(): state["running"]=False; cap.release(); root.destroy()
    root.protocol("WM_DELETE_WINDOW",close); tick(); root.mainloop()


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--camera-index",type=int,default=1); ap.add_argument("--gpu",action="store_true"); ap.add_argument("--headless",action="store_true"); ap.add_argument("--frames",type=int,default=60); ap.add_argument("--baseline-frames",type=int,default=60); ap.add_argument("--min-confidence",type=float,default=0.18); args=ap.parse_args()
    if args.headless: run_headless(args)
    else: run_gui(args)


if __name__ == "__main__": main()

