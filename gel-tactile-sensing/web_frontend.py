"""Local web wrapper for the gel tactile frontend.

Serves the web UI and exposes the existing OpenCV/model pipeline over a small
stdlib HTTP API. Run with: python web_frontend.py --camera-index 1 --gpu
"""
from __future__ import annotations

import argparse
import json
import threading
import time
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

from tactile_frontend import Model, prepare_frame, infer_frame, FIELD_STEP, MODEL_SCHEMA, score_layers

ROOT = Path(__file__).resolve().parent
WEB_ROOT = ROOT / "web"
TRAINING_REFERENCE = ROOT / "assets" / "synthetic_reference.png"


def placeholder(text: str) -> np.ndarray:
    image = np.zeros((256, 400, 3), np.uint8)
    image[:] = (5, 8, 12)
    cv2.putText(image, text, (28, 132), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (99, 115, 131), 1, cv2.LINE_AA)
    return image


def read_image(path: Path) -> np.ndarray | None:
    if not path.exists():
        return None
    data = np.fromfile(str(path), dtype=np.uint8)
    return cv2.imdecode(data, cv2.IMREAD_COLOR) if data.size else None


def estimate_calibration_warp(reference: np.ndarray | None, current: np.ndarray) -> tuple[np.ndarray, dict]:
    """Align a live zero image to the calibration camera coordinate system."""
    identity = np.eye(2, 3, dtype=np.float32)
    info = {"active": False, "ecc": None, "warp": identity.tolist(), "reason": "reference_unavailable"}
    if reference is None or reference.shape[:2] != current.shape[:2]:
        return identity, info
    template = cv2.normalize(cv2.cvtColor(reference, cv2.COLOR_BGR2GRAY), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    live = cv2.normalize(cv2.cvtColor(current, cv2.COLOR_BGR2GRAY), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
    try:
        score, warp = cv2.findTransformECC(
            template, live, identity.copy(), cv2.MOTION_AFFINE,
            (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 100, 1e-5),
        )
    except cv2.error:
        return identity, {**info, "reason": "ecc_failed"}
    determinant = float(np.linalg.det(warp[:, :2]))
    if not np.isfinite(score) or score < 0.90 or not 0.70 <= determinant <= 1.30:
        return identity, {**info, "ecc": float(score), "reason": "ecc_outside_acceptance"}
    return warp.astype(np.float32), {"active": True, "ecc": float(score), "warp": warp.astype(float).tolist(), "reason": "accepted"}


class TactileEngine:
    def __init__(
        self,
        camera_index: int,
        use_gpu: bool,
        baseline_frames: int,
        min_confidence: float,
        warmup_seconds: float,
        opencv_threads: int,
    ):
        self.lock = threading.RLock()
        self.updated = threading.Condition(self.lock)
        self.capture_lock = threading.Lock()
        self.opencv_threads = max(1, int(opencv_threads))
        cv2.setNumThreads(self.opencv_threads)
        self.cap = cv2.VideoCapture(camera_index, cv2.CAP_DSHOW)
        self.camera_ready = bool(self.cap.isOpened())
        self.model = Model(use_gpu=use_gpu, validate_training_dataset=True)
        self.gpu_requested = bool(use_gpu)
        self.baseline_frames = int(baseline_frames)
        self.min_confidence = float(min_confidence)
        self.warmup_seconds = max(0.0, float(warmup_seconds))
        self.camera_started_at = time.perf_counter()
        self.camera_config = self._configure_camera() if self.camera_ready else {}
        self.base = None
        self.base_layers = None
        self.alignment_warp = np.eye(2, 3, dtype=np.float32)
        self.alignment = {"active": False, "ecc": None, "warp": self.alignment_warp.tolist(), "reason": "not_calibrated"}
        self.frames = []
        self.history = [[], [], []]
        self.quiet_flow_p90: deque[float] = deque(maxlen=120)
        self.quiet_local_diff: deque[float] = deque(maxlen=120)
        self.jpg = self._encode(placeholder("CAMERA UNAVAILABLE" if not self.camera_ready else "CALIBRATING ZERO"))
        self.frame_cache: OrderedDict[int, bytes] = OrderedDict([(0, self.jpg)])
        self.contact_cache: OrderedDict[int, bytes] = OrderedDict()
        self.contact_debug: OrderedDict[int, dict] = OrderedDict()
        self.frame_cache_capacity = 120
        self.frame_seq = 0
        self.capture_seq = 0
        self.latest_frame = None
        self.latest_capture_timestamp_ns = 0
        self.running = True
        self.last_capture_tick = None
        self.last_tick = time.perf_counter()
        self.fps = 0.0
        self.processing_latency_ms = 0.0
        self.processing_latency_history: deque[float] = deque(maxlen=240)
        self.processing_latency_p95_ms = 0.0
        self.calibration_generation = 0
        nominal_fps = float(self.cap.get(cv2.CAP_PROP_FPS)) if self.camera_ready else 0.0
        self.camera_fps = nominal_fps if np.isfinite(nominal_fps) and nominal_fps > 0 else 0.0
        self.state = self._state(
            "error" if not self.camera_ready else "calibrating",
            "CAMERA UNAVAILABLE" if not self.camera_ready else "WARMING CAMERA",
            [0, 0, 0], [0, 0, 0], 0.0,
            {"raw_confidence": 0.0, "flow_p90": 0.0, "ood": False, "signal_present": False},
        )

    def _configure_camera(self) -> dict:
        """Request a low-latency UVC profile and report every lock attempt.

        DirectShow drivers commonly expose ``-1`` for unsupported controls.  A
        missing property is therefore reported as unavailable instead of being
        presented as if exposure, gain, or white balance had been fixed.
        """
        requested = {
            "width": 640,
            "height": 480,
            "fps": 30,
            "fourcc": int(cv2.VideoWriter_fourcc(*"MJPG")),
            "buffer_size": 1,
        }
        properties = {
            "width": cv2.CAP_PROP_FRAME_WIDTH,
            "height": cv2.CAP_PROP_FRAME_HEIGHT,
            "fps": cv2.CAP_PROP_FPS,
            "fourcc": cv2.CAP_PROP_FOURCC,
            "buffer_size": cv2.CAP_PROP_BUFFERSIZE,
        }
        manual_properties = {
            "auto_exposure": cv2.CAP_PROP_AUTO_EXPOSURE,
            "exposure": cv2.CAP_PROP_EXPOSURE,
            "gain": cv2.CAP_PROP_GAIN,
            "auto_white_balance": cv2.CAP_PROP_AUTO_WB,
            "white_balance_temperature": cv2.CAP_PROP_WB_TEMPERATURE,
        }
        all_properties = {**properties, **manual_properties}
        report = {
            "requested": {**requested, "auto_exposure": 0.0, "auto_white_balance": 0.0},
            "effective": {},
            "locked": {},
            "properties": {},
            "unlocked_properties": [],
            "unsupported_properties": [],
            "warnings": [],
        }

        def read(name: str) -> float | None:
            try:
                value = float(self.cap.get(all_properties[name]))
            except (cv2.error, TypeError, ValueError):
                return None
            # OpenCV uses -1 as the conventional "not supported" value for
            # several capture properties; negative exposure values are valid.
            return None if not np.isfinite(value) or value == -1.0 else value

        def mark_unavailable(name: str, reason: str) -> None:
            report["locked"][name] = False
            if name not in report["unsupported_properties"]:
                report["unsupported_properties"].append(name)
            report["properties"][name] = {"locked": False, "reason": reason}

        def apply(name: str, value: float, tolerance: float, accepted=None, *, attempt_when_unreadable: bool = True) -> None:
            before = read(name)
            if before is None and not attempt_when_unreadable:
                mark_unavailable(name, "driver_property_unavailable_before_set")
                return
            try:
                set_ok = bool(self.cap.set(all_properties[name], value))
                set_error = None
            except (cv2.error, TypeError, ValueError) as exc:
                set_ok = False
                set_error = f"{type(exc).__name__}: {exc}"
            after = read(name)
            report["effective"][name] = after
            if after is None:
                mark_unavailable(name, set_error or "driver_property_unavailable_after_set")
                return
            matches = bool(accepted(after) if accepted is not None else abs(after - value) <= tolerance)
            locked = bool(set_ok and matches)
            report["locked"][name] = locked
            report["properties"][name] = {
                "requested": float(value), "before": before, "after": after,
                "set_ok": set_ok, "locked": locked,
                "reason": set_error or ("accepted" if locked else "driver_rejected_value"),
            }
            if not locked:
                report["unlocked_properties"].append(name)

        # Establish the transport profile first; dimensions/FPS are checked
        # with a practical tolerance because DirectShow may quantise FPS.
        apply("width", requested["width"], 0.5)
        apply("height", requested["height"], 0.5)
        apply("fps", requested["fps"], 1.0)
        apply("fourcc", requested["fourcc"], 0.5)
        apply("buffer_size", requested["buffer_size"], 0.5, attempt_when_unreadable=False)

        # Turn off automatic controls only when the driver exposes them.  A
        # number of DirectShow backends encode manual exposure as 0.25 rather
        # than 0.0, so accept both representations as a successful lock.
        manual_mode = lambda value: abs(float(value)) <= 0.05 or abs(float(value) - 0.25) <= 0.05
        apply("auto_exposure", 0.0, 0.05, manual_mode, attempt_when_unreadable=False)
        apply("auto_white_balance", 0.0, 0.05, manual_mode, attempt_when_unreadable=False)
        for name in ("exposure", "gain", "white_balance_temperature"):
            current = read(name)
            if current is None:
                mark_unavailable(name, "driver_property_unavailable")
            else:
                apply(name, current, max(0.05, abs(current) * 0.01))

        report["unlocked_properties"] = sorted(set(report["unlocked_properties"]))
        report["unsupported_properties"] = sorted(set(report["unsupported_properties"]))
        report["lock_summary"] = "locked" if not report["unlocked_properties"] and not report["unsupported_properties"] else "partial_or_unavailable"
        if report["unsupported_properties"]:
            report["warnings"].append("some UVC manual controls are not exposed by the DirectShow driver")
        if report["unlocked_properties"]:
            report["warnings"].append("one or more requested UVC values were not accepted by the driver")
        return report

    @staticmethod
    def _encode(image: np.ndarray) -> bytes:
        ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 86])
        return encoded.tobytes() if ok else b""

    def _state(
        self,
        status_class,
        status_text,
        force,
        contact,
        confidence,
        diagnostics=None,
        valid=False,
        ood=False,
        field=None,
        pressure_grid=None,
        force_status="no_contact",
        contact_detected=False,
        contact_px=None,
        capture_timestamp_ns=0,
    ):
        return {
            "status_class": status_class, "status_text": status_text,
            "force_N": [float(x) for x in force], "contact_mm": [float(x) for x in contact],
            "confidence": float(confidence), "valid": bool(valid), "measurement_valid": bool(valid), "ood": bool(ood),
            "force_status": force_status, "contact_detected": bool(contact_detected),
            "force_estimate_available": bool(force_status in {"valid", "bounded_ood", "low_confidence"}),
            "confidence_limited": bool(force_status == "low_confidence"),
            "contact_px": contact_px,
            "fps": float(self.fps), "inference_fps": float(self.fps),
            # ``--gpu`` is retained for CLI compatibility, but the active
            # production path uses CPU Farneback and CPU model inference.
            "gpu": bool(self.model.runtime_backend.startswith("GPU")),
            "gpu_requested": bool(self.gpu_requested),
            "backend": self.model.runtime_backend, "frame_ready": bool(self.jpg),
            "camera_fps": float(self.camera_fps),
            "frame_seq": self.frame_seq, "capture_timestamp_ns": int(capture_timestamp_ns),
            "processing_latency_ms": float(self.processing_latency_ms),
            "processing_latency_p95_ms": float(self.processing_latency_p95_ms),
            "history": self.history,
            "field": field or {"width": 400, "height": 256, "step": FIELD_STEP, "points": []},
            "pressure_grid": pressure_grid or {
                "width": 400, "height": 256, "step": FIELD_STEP,
                "unit": "N/cell", "estimated": True, "bounded": False, "points": [],
                "weighting": {},
            },
            "model": {
                "schema": self.model.schema,
                "path": self.model.path,
                "package_sha256": self.model.package_sha256,
                "training_dataset_schema": self.model.training_dataset_schema,
                "training_dataset_sha256": self.model.training_dataset_sha256,
                "training_dataset_binding_verified": self.model.training_dataset_binding_verified,
                "contract_version": self.model.contract_version,
                "source": "calibrated_model",
                "kind": self.model.runtime_model_kind,
                "reference_labels": self.model.reference_label_sensor,
                "force_unit": "N",
                "contact_unit": "mm",
            },
            "camera_config": self.camera_config,
            "alignment": self.alignment,
            "runtime_config": {
                "opencv_threads": self.opencv_threads,
                "frame_cache_capacity": self.frame_cache_capacity,
                "calibration_generation": self.calibration_generation,
            },
            "contact_debug": {
                "cached_frame_sequences": list(self.contact_cache.keys()),
                "last": self.contact_debug[next(reversed(self.contact_debug))] if self.contact_debug else None,
            },
            "diagnostics": diagnostics or {},
        }

    def recalibrate(self):
        with self.updated:
            self.calibration_generation += 1
            self.base = None
            self.base_layers = None
            self.alignment_warp = np.eye(2, 3, dtype=np.float32)
            self.alignment = {"active": False, "ecc": None, "warp": self.alignment_warp.tolist(), "reason": "not_calibrated"}
            self.frames = []
            self.history = [[], [], []]
            self.quiet_flow_p90.clear()
            self.quiet_local_diff.clear()
            self.camera_started_at = time.perf_counter()
            self.updated.notify_all()

    def tick(self, frame=None, capture_timestamp_ns=0):
        started = time.perf_counter()
        if not self.camera_ready:
            time.sleep(0.15); return
        if frame is None:
            ok, frame = self.cap.read()
            if not ok:
                with self.updated:
                    self.state = self._state("error", "CAMERA READ ERROR", [0, 0, 0], [0, 0, 0], 0.0, {"raw_confidence": 0.0, "flow_p90": 0.0, "ood": False})
                    self.updated.notify_all()
                time.sleep(0.05); return
        prep = prepare_frame(frame)
        status_class = "calibrating"
        status_text = "CALIBRATING ZERO"
        force = np.zeros(3, np.float32)
        contact = np.zeros(3, np.float32)
        confidence = 0.0
        diagnostics = {"raw_confidence": 0.0, "flow_p90": 0.0, "ood": False, "signal_present": False}
        field = None
        pressure_grid = None
        valid = False
        ood = False
        force_status = "no_contact"
        contact_detected = False
        contact_px = None
        next_base = None
        with self.lock:
            generation = self.calibration_generation
            base = self.base
            base_layers = self.base_layers
            alignment_warp = self.alignment_warp.copy()
            elapsed_from_open = time.perf_counter() - self.camera_started_at
        if elapsed_from_open < self.warmup_seconds:
            status_text = f"WARMING CAMERA {elapsed_from_open:.1f}/{self.warmup_seconds:.1f}s"
            view = prep
        elif base is None:
            with self.lock:
                # Recalibration may have occurred after the snapshot above.
                if generation != self.calibration_generation:
                    return
                self.frames.append(prep)
                frame_count = len(self.frames)
                if frame_count >= self.baseline_frames:
                    raw_base = np.median(np.stack(self.frames), axis=0).astype(np.uint8)
                    reference = read_image(TRAINING_REFERENCE)
                    warp, alignment = estimate_calibration_warp(reference, raw_base)
                    self.alignment_warp = warp
                    self.alignment = alignment
                    self.base = self._apply_alignment(raw_base, warp)
                    self.base_layers = score_layers(self.base)
                    self.frames = []
                    base = self.base
                    base_layers = self.base_layers
                    frame_count = self.baseline_frames
                else:
                    base = None
            if base is not None:
                status_class = "waiting"
                status_text = "WAITING FOR CONTACT"
            else:
                status_text = f"CALIBRATING ZERO {frame_count}/{self.baseline_frames}"
            view = prep
        else:
            prep = self._apply_alignment(prep, alignment_warp)
            result = infer_frame(
                prep, base, self.model, self.min_confidence,
                adaptive_contact_thresholds=self._adaptive_contact_thresholds(),
                base_layers=base_layers,
            )
            view = result["view"]
            confidence = result["confidence"]
            force = result["force"]
            contact = result["contact"]
            valid = result["valid"]
            ood = result["ood"]
            force_status = result["force_status"]
            contact_detected = result["contact_detected"]
            contact_px = result.get("contact_px")
            status_class = result["status_class"]
            status_text = result["status_text"]
            diagnostics = result["diagnostics"]
            field = result["field"]
            pressure_grid = result["pressure_grid"]
            if not diagnostics.get("signal_present", False):
                # Slowly absorb long-lived illumination drift only while contact
                # is absent.  A contact frame can never alter the zero image.
                next_base = cv2.addWeighted(base, 0.995, prep, 0.005, 0.0)
                self._record_quiet_optical_metrics(diagnostics)
            else:
                next_base = None
        now = time.perf_counter()
        elapsed = max(now - self.last_tick, 1e-6)
        self.fps = 0.9 * self.fps + 0.1 / elapsed
        self.last_tick = now
        if capture_timestamp_ns:
            self.processing_latency_ms = max(0.0, (time.time_ns() - capture_timestamp_ns) / 1_000_000.0)
        else:
            self.processing_latency_ms = (now - started) * 1000.0
        self.processing_latency_history.append(float(self.processing_latency_ms))
        self.processing_latency_p95_ms = float(np.percentile(self.processing_latency_history, 95))
        encoded = self._encode(view)
        with self.updated:
            if generation != self.calibration_generation:
                # Never publish a frame inferred against a discarded zero image.
                return
            if next_base is not None:
                self.base = next_base
            for axis in range(3):
                self.history[axis].append(float(force[axis]))
                self.history[axis] = self.history[axis][-80:]
            self.jpg = encoded
            self.frame_seq += 1
            self.frame_cache[self.frame_seq] = encoded
            while len(self.frame_cache) > self.frame_cache_capacity:
                self.frame_cache.popitem(last=False)
            if contact_detected:
                self.contact_cache[self.frame_seq] = encoded
                self.contact_debug[self.frame_seq] = {
                    "frame_seq": self.frame_seq,
                    "force_status": force_status,
                    "measurement_valid": bool(valid),
                    "force_N": [float(value) for value in force],
                    "raw_force_N": diagnostics.get("raw_force_N"),
                    "ood_detail": diagnostics.get("ood_detail"),
                    "alignment": self.alignment,
                    "diagnostics": diagnostics,
                }
                while len(self.contact_cache) > 20:
                    self.contact_cache.popitem(last=False)
                while len(self.contact_debug) > 20:
                    self.contact_debug.popitem(last=False)
            self.state = self._state(
                status_class, status_text, force, contact, confidence, diagnostics,
                valid, ood, field, pressure_grid, force_status, contact_detected, contact_px,
                capture_timestamp_ns,
            )
            self.updated.notify_all()

    def _adaptive_contact_thresholds(self) -> tuple[float, float]:
        """Derive a conservative optical gate from this camera's quiet state."""
        if len(self.quiet_flow_p90) < 30 or len(self.quiet_local_diff) < 30:
            return 0.80, 6.00
        flow = np.asarray(self.quiet_flow_p90, dtype=np.float32)
        diff = np.asarray(self.quiet_local_diff, dtype=np.float32)
        flow_median = float(np.median(flow))
        diff_median = float(np.median(diff))
        flow_mad = float(np.median(np.abs(flow - flow_median)))
        diff_mad = float(np.median(np.abs(diff - diff_median)))
        return (
            max(0.80, flow_median + 4.0 * max(flow_mad, 0.03)),
            max(5.50, diff_median + 3.0 * max(diff_mad, 0.20)),
        )

    def _record_quiet_optical_metrics(self, diagnostics: dict) -> None:
        probability = diagnostics.get("contact_probability")
        if probability is not None and float(probability) >= 0.10:
            return
        flow_p90 = float(diagnostics.get("flow_p90", 0.0))
        local_diff = float(diagnostics.get("local_diff", 0.0))
        if np.isfinite(flow_p90) and np.isfinite(local_diff):
            self.quiet_flow_p90.append(flow_p90)
            self.quiet_local_diff.append(local_diff)

    @staticmethod
    def _apply_alignment(image: np.ndarray, warp: np.ndarray) -> np.ndarray:
        return cv2.warpAffine(
            image, warp, (image.shape[1], image.shape[0]),
            flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
            borderMode=cv2.BORDER_REPLICATE,
        )

    def loop(self):
        processed_capture_seq = 0
        while self.running:
            with self.capture_lock:
                frame = self.latest_frame
                capture_seq = self.capture_seq
                capture_timestamp_ns = self.latest_capture_timestamp_ns
            if frame is None or capture_seq == processed_capture_seq:
                time.sleep(0.001)
                continue
            processed_capture_seq = capture_seq
            try:
                self.tick(frame, capture_timestamp_ns)
            except Exception as exc:
                with self.updated:
                    self.state = self._state(
                        "error", f"INFERENCE ERROR: {type(exc).__name__}",
                        [0, 0, 0], [0, 0, 0], 0.0,
                        {"error": f"{type(exc).__name__}: {exc}", "signal_present": False},
                    )
                    self.updated.notify_all()
                time.sleep(0.05)

    def snapshot(self):
        with self.lock:
            state = dict(self.state)
            state["history"] = [list(values) for values in self.history]
            return state

    def frame(self, sequence=None):
        with self.lock:
            if sequence is None:
                return self.jpg
            return self.frame_cache.get(sequence)

    def contact_frame(self, sequence=None):
        with self.lock:
            if sequence is None:
                if not self.contact_cache:
                    return None
                return self.contact_cache[next(reversed(self.contact_cache))]
            return self.contact_cache.get(sequence)

    def contact_state(self, sequence=None):
        with self.lock:
            if sequence is None:
                if not self.contact_debug:
                    return None
                return self.contact_debug[next(reversed(self.contact_debug))]
            return self.contact_debug.get(sequence)

    def wait_for_update(self, after_sequence: int, timeout: float = 15.0):
        deadline = time.monotonic() + timeout
        with self.updated:
            while self.running and self.frame_seq <= after_sequence:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return None
                self.updated.wait(remaining)
            return self.snapshot() if self.frame_seq > after_sequence else None

    def close(self):
        with self.updated:
            self.running = False
            self.updated.notify_all()
        if self.cap: self.cap.release()

    def capture_loop(self):
        """Read every available camera frame and publish the newest one."""
        while self.running:
            ok, frame = self.cap.read()
            now = time.perf_counter()
            if not ok:
                time.sleep(0.05)
                continue
            with self.capture_lock:
                if self.last_capture_tick is not None:
                    elapsed = max(now - self.last_capture_tick, 1e-6)
                    rate = 1.0 / elapsed
                    self.camera_fps = rate if self.camera_fps <= 0 else 0.9 * self.camera_fps + 0.1 * rate
                self.last_capture_tick = now
                self.latest_frame = frame
                self.latest_capture_timestamp_ns = time.time_ns()
                self.capture_seq += 1


class Handler(BaseHTTPRequestHandler):
    server_version = "GelTactile/1.0"

    def log_message(self, format, *args):
        return

    @property
    def engine(self): return self.server.engine  # type: ignore[attr-defined]

    def send_bytes(self, payload: bytes, content_type: str, status=200):
        self.send_response(status); self.send_header("Content-Type", content_type); self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload)

    @staticmethod
    def _integer(values, default=0):
        try:
            return int(values[0]) if values else default
        except (TypeError, ValueError):
            return default

    def send_events(self, after_sequence: int):
        """Push only completed frames; slow clients naturally skip stale frames."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-store")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        sequence = after_sequence
        try:
            while self.engine.running:
                state = self.engine.wait_for_update(sequence)
                if state is None:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    continue
                sequence = int(state["frame_seq"])
                payload = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                self.wfile.write(f"id: {sequence}\n".encode("ascii"))
                self.wfile.write(b"event: frame\n")
                self.wfile.write(b"data: " + payload + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/api/state":
            self.send_bytes(json.dumps(self.engine.snapshot()).encode("utf-8"), "application/json; charset=utf-8"); return
        if path == "/api/events":
            last_event = self.headers.get("Last-Event-ID")
            after = self._integer(query.get("after"), self._integer([last_event], 0))
            self.send_events(after)
            return
        if path == "/api/frame.jpg":
            requested = self._integer(query.get("seq"), -1)
            payload = self.engine.frame(None if requested < 0 else requested)
            if payload is None:
                self.send_bytes(b"Frame is no longer available", "text/plain; charset=utf-8", 410)
            else:
                self.send_bytes(payload, "image/jpeg")
            return
        if path == "/api/contact.jpg":
            requested = self._integer(query.get("seq"), -1)
            payload = self.engine.contact_frame(None if requested < 0 else requested)
            if payload is None:
                self.send_bytes(b"Contact frame is no longer available", "text/plain; charset=utf-8", 410)
            else:
                self.send_bytes(payload, "image/jpeg")
            return
        if path == "/api/contact-state":
            requested = self._integer(query.get("seq"), -1)
            payload = self.engine.contact_state(None if requested < 0 else requested)
            if payload is None:
                self.send_bytes(b"Contact state is no longer available", "text/plain; charset=utf-8", 410)
            else:
                self.send_bytes(json.dumps(payload).encode("utf-8"), "application/json; charset=utf-8")
            return
        if path in ("/", "/index.html", "/styles.css", "/app.js"):
            file_path = WEB_ROOT / ("index.html" if path == "/" else path.lstrip("/"))
            if file_path.exists(): self.send_bytes(file_path.read_bytes(), "text/html; charset=utf-8" if file_path.suffix == ".html" else ("text/css; charset=utf-8" if file_path.suffix == ".css" else "application/javascript; charset=utf-8")); return
        self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)

    def do_POST(self):
        if urlparse(self.path).path == "/api/recalibrate": self.engine.recalibrate(); self.send_bytes(b'{"ok":true}', "application/json"); return
        self.send_bytes(b"Not found", "text/plain; charset=utf-8", 404)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--camera-index", type=int, default=1)
    parser.add_argument("--gpu", action="store_true", help="Retained for compatibility; live optical flow reports its actual backend.")
    parser.add_argument("--baseline-frames", type=int, default=60)
    parser.add_argument("--warmup-seconds", type=float, default=2.0)
    parser.add_argument("--opencv-threads", type=int, default=8)
    parser.add_argument("--min-confidence", type=float, default=0.18)
    args = parser.parse_args()
    engine = TactileEngine(
        args.camera_index, args.gpu, args.baseline_frames, args.min_confidence,
        args.warmup_seconds, args.opencv_threads,
    )
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.engine = engine  # type: ignore[attr-defined]
    capture_worker = threading.Thread(target=engine.capture_loop, daemon=True); capture_worker.start()
    worker = threading.Thread(target=engine.loop, daemon=True); worker.start(); print(f"Gel tactile web frontend: http://{args.host}:{args.port}")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.shutdown(); engine.close()


if __name__ == "__main__": main()

