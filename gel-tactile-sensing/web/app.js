const $ = (id) => document.getElementById(id);

const DEFAULT_FIELD = { width: 400, height: 256, points: [] };
const DEFAULT_PRESSURE_GRID = { width: 400, height: 256, unit: "N/cell", estimated: true, bounded: false, points: [], weighting: {} };
const DEFAULT_DATA = {
  field: DEFAULT_FIELD,
  pressure_grid: DEFAULT_PRESSURE_GRID,
  force_N: [0, 0, 0],
  contact_mm: [0, 0, 0],
  history: [[], [], []],
  frame_ready: false,
  frame_seq: -1,
};

const runtime = {
  lastCommittedData: DEFAULT_DATA,
  lastCommittedSeq: -1,
  pendingPacket: null,
  applyingPacket: false,
  nextPacketToken: 0,
  eventSource: null,
  sseReady: false,
  sseTimeout: null,
  sseRetryTimer: null,
  polling: false,
  pollTimer: null,
  resyncing: false,
  transport: "CONNECTING STREAM",
  resizeQueued: false,
  presentationLatencies: [],
};

const KNOWN_STATUS_CLASSES = new Set(["live", "calibrating", "waiting", "ood", "bounded_ood", "low_confidence", "saturated", "no_contact", "connecting", "error"]);

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function signed(value) {
  if (!Number.isFinite(Number(value))) return "--";
  const number = Number(value);
  if (Math.abs(number) < 0.005) return "0.00";
  return `${number >= 0 ? "+" : ""}${number.toFixed(2)}`;
}

function asTriplet(value) {
  if (Array.isArray(value)) return [finiteNumber(value[0]), finiteNumber(value[1]), finiteNumber(value[2])];
  if (value && typeof value === "object") return [finiteNumber(value.x), finiteNumber(value.y), finiteNumber(value.z)];
  return [0, 0, 0];
}

function normalizeFrameSeq(data) {
  const sequence = Number(data && data.frame_seq);
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : runtime.lastCommittedSeq + 1;
}

function forceStatus(data) {
  if (typeof data.force_status === "string") return data.force_status;
  if (data.ood) return "bounded_ood";
  if (data.valid || data.measurement_valid) return "valid";
  return "no_contact";
}

function isBounded(data) {
  const grid = data && data.pressure_grid;
  return Boolean(grid && grid.bounded) || forceStatus(data || {}) === "bounded_ood";
}

function measurementValid(data) {
  if (typeof data.measurement_valid === "boolean") return data.measurement_valid;
  return Boolean(data.valid);
}

function normalizeFieldPoint(point) {
  if (Array.isArray(point)) {
    return {
      x: finiteNumber(point[0]), y: finiteNumber(point[1]), ux: finiteNumber(point[2]), uy: finiteNumber(point[3]),
      magnitude: Number.isFinite(Number(point[4])) ? Math.max(0, Number(point[4])) : Math.hypot(finiteNumber(point[2]), finiteNumber(point[3])),
    };
  }
  if (point && typeof point === "object") {
    const ux = finiteNumber(point.ux);
    const uy = finiteNumber(point.uy);
    return {
      x: finiteNumber(point.x), y: finiteNumber(point.y), ux, uy,
      magnitude: Number.isFinite(Number(point.magnitude)) ? Math.max(0, Number(point.magnitude)) : Math.hypot(ux, uy),
    };
  }
  return null;
}

function normalizePressurePoint(point) {
  if (Array.isArray(point)) return { x: finiteNumber(point[0]), y: finiteNumber(point[1]), force: finiteNumber(point[2]) };
  if (point && typeof point === "object") return { x: finiteNumber(point.x), y: finiteNumber(point.y), force: finiteNumber(point.cell_force_N ?? point.force ?? point.value) };
  return null;
}

function setStatus(statusClass, text) {
  const className = KNOWN_STATUS_CLASSES.has(statusClass) ? statusClass : "connecting";
  const node = $("status");
  node.className = `status status-${className}`;
  node.textContent = text || "CONNECTING";
}

function setTransport(text) {
  runtime.transport = text;
  $("transport").textContent = text;
}

function setCanvasSize(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { context, width: rect.width, height: rect.height };
}

function containedBounds(width, height, sourceWidth, sourceHeight) {
  const inputWidth = Math.max(1, finiteNumber(sourceWidth, 400));
  const inputHeight = Math.max(1, finiteNumber(sourceHeight, 256));
  const scale = Math.min(width / inputWidth, height / inputHeight);
  const drawWidth = inputWidth * scale;
  const drawHeight = inputHeight * scale;
  return { scale, x: (width - drawWidth) / 2, y: (height - drawHeight) / 2, width: drawWidth, height: drawHeight };
}

function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))];
}

function flowColor(strength) {
  const hue = Math.round(202 - Math.max(0, Math.min(1, strength)) * 168);
  return `hsl(${hue} 87% 64%)`;
}

function pressureColor(strength, bounded) {
  const normalized = Math.max(0, Math.min(1, strength));
  if (bounded) return `hsl(${Math.round(45 - normalized * 25)} 95% ${Math.round(58 + normalized * 6)}%)`;
  return `hsl(${Math.round(208 - normalized * 184)} 88% ${Math.round(55 + normalized * 8)}%)`;
}

function drawArrow(context, x, y, dx, dy, color) {
  const length = Math.hypot(dx, dy);
  if (length < 0.8) return;
  const endX = x + dx;
  const endY = y + dy;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 1.25;
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(endX, endY);
  context.stroke();
  if (length < 4) return;
  const angle = Math.atan2(dy, dx);
  const head = Math.min(4.5, Math.max(2.2, length * 0.28));
  context.beginPath();
  context.moveTo(endX, endY);
  context.lineTo(endX - head * Math.cos(angle - 0.52), endY - head * Math.sin(angle - 0.52));
  context.lineTo(endX - head * Math.cos(angle + 0.52), endY - head * Math.sin(angle + 0.52));
  context.closePath();
  context.fill();
}

function drawContactMarker(context, data, bounds) {
  const contact = data && data.contact_px;
  const xValue = Number(Array.isArray(contact) ? contact[0] : (contact && contact.x));
  const yValue = Number(Array.isArray(contact) ? contact[1] : (contact && contact.y));
  if (!Number.isFinite(xValue) || !Number.isFinite(yValue)) return;
  const x = bounds.x + xValue * bounds.scale;
  const y = bounds.y + yValue * bounds.scale;
  if (x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height) return;
  const radius = Math.max(7, Math.min(13, 8 * bounds.scale));
  context.strokeStyle = "#f2b667";
  context.fillStyle = "rgba(242, 182, 103, .14)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(x - radius - 4, y);
  context.lineTo(x + radius + 4, y);
  context.moveTo(x, y - radius - 4);
  context.lineTo(x, y + radius + 4);
  context.stroke();
}

function drawField(data) {
  const canvas = $("flowCanvas");
  const { context, width, height } = setCanvasSize(canvas);
  context.clearRect(0, 0, width, height);
  const field = data.field && typeof data.field === "object" ? data.field : DEFAULT_FIELD;
  const points = Array.isArray(field.points) ? field.points.map(normalizeFieldPoint).filter(Boolean) : [];
  const bounds = containedBounds(width, height, field.width, field.height);

  context.strokeStyle = "rgba(91, 189, 255, .2)";
  context.lineWidth = 1;
  context.strokeRect(bounds.x + .5, bounds.y + .5, Math.max(0, bounds.width - 1), Math.max(0, bounds.height - 1));

  const reference = Math.max(0.08, percentile(points.map((point) => point.magnitude).filter((value) => value > 0), 0.9));
  points.forEach((point) => {
    const x = bounds.x + point.x * bounds.scale;
    const y = bounds.y + point.y * bounds.scale;
    const strength = Math.min(1, point.magnitude / reference);
    const lengthScale = Math.min(2.3, 0.9 + strength * 1.4);
    drawArrow(context, x, y, point.ux * bounds.scale * lengthScale, point.uy * bounds.scale * lengthScale, flowColor(strength));
  });
  drawContactMarker(context, data, bounds);

  $("flowMeta").textContent = points.length ? `fused deformation vectors / ${points.length} samples` : "fused deformation vectors";
  $("flowDetail").textContent = points.length ? `FLOW P90 ${percentile(points.map((point) => point.magnitude), 0.9).toFixed(2)} PX` : "NO FLOW SAMPLES";
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => Math.round(value * 1000) / 1000))].sort((a, b) => a - b);
}

function minimumSpacing(values) {
  if (values.length < 2) return 0;
  let spacing = Infinity;
  for (let index = 1; index < values.length; index += 1) spacing = Math.min(spacing, values[index] - values[index - 1]);
  return Number.isFinite(spacing) ? spacing : 0;
}

function drawPressureGrid(data) {
  const canvas = $("pressureCanvas");
  const { context, width, height } = setCanvasSize(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#061017";
  context.fillRect(0, 0, width, height);

  const grid = data.pressure_grid && typeof data.pressure_grid === "object" ? data.pressure_grid : DEFAULT_PRESSURE_GRID;
  const points = Array.isArray(grid.points) ? grid.points.map(normalizePressurePoint).filter(Boolean) : [];
  const bounds = containedBounds(width, height, grid.width, grid.height);
  const bounded = isBounded(data);
  const nonzero = points.map((point) => Math.abs(point.force)).filter((force) => force > 0);
  const reference = Math.max(0.01, percentile(nonzero, 0.9));
  const xValues = uniqueSorted(points.map((point) => point.x));
  const yValues = uniqueSorted(points.map((point) => point.y));
  const spacing = Math.max(2, Math.min(
    minimumSpacing(xValues) || finiteNumber(grid.width, 400) / 19,
    minimumSpacing(yValues) || finiteNumber(grid.height, 256) / 19,
  ) * bounds.scale);

  context.save();
  context.beginPath();
  context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
  context.clip();
  context.strokeStyle = bounded ? "rgba(242, 182, 103, .18)" : "rgba(91, 189, 255, .14)";
  context.lineWidth = 1;
  xValues.forEach((x) => {
    const drawX = bounds.x + x * bounds.scale;
    context.beginPath();
    context.moveTo(drawX, bounds.y);
    context.lineTo(drawX, bounds.y + bounds.height);
    context.stroke();
  });
  yValues.forEach((y) => {
    const drawY = bounds.y + y * bounds.scale;
    context.beginPath();
    context.moveTo(bounds.x, drawY);
    context.lineTo(bounds.x + bounds.width, drawY);
    context.stroke();
  });

  points.forEach((point) => {
    const x = bounds.x + point.x * bounds.scale;
    const y = bounds.y + point.y * bounds.scale;
    const strength = Math.abs(point.force) <= 0 ? 0 : Math.min(1, Math.sqrt(Math.abs(point.force) / reference));
    const radius = Math.abs(point.force) <= 0 ? Math.max(1.2, spacing * .09) : Math.max(2, Math.min(spacing * .45, spacing * (.12 + .33 * strength)));
    context.fillStyle = Math.abs(point.force) <= 0
      ? "rgba(32, 108, 141, .52)"
      : (point.force < 0 ? "hsl(190 85% 63%)" : pressureColor(strength, bounded));
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  });
  context.restore();

  context.strokeStyle = bounded ? "#e78655" : "rgba(91, 189, 255, .58)";
  context.lineWidth = bounded ? 2 : 1;
  if (bounded) context.setLineDash([6, 4]);
  context.strokeRect(bounds.x + .5, bounds.y + .5, Math.max(0, bounds.width - 1), Math.max(0, bounds.height - 1));
  context.setLineDash([]);

  const panel = $("pressurePanel");
  panel.classList.toggle("is-bounded", bounded);
  panel.classList.toggle("is-low-confidence", forceStatus(data) === "low_confidence" || data.confidence_limited === true);
  $("pressureBoundedBadge").hidden = !bounded;
  const unit = typeof grid.unit === "string" && grid.unit.trim() ? grid.unit : "N/cell";
  const estimated = grid.estimated === false ? "reported" : "estimated";
  const forceAvailable = grid.force_estimate_available !== false && unit.toLowerCase().includes("n/");
  $("pressureMeta").textContent = `${estimated} distribution / ${unit}`;
  $("pressureUnit").textContent = `${unit.toUpperCase()} ${estimated.toUpperCase()}`;
  const hasPressureSignal = nonzero.length > 0;
  const lowConfidence = forceStatus(data) === "low_confidence" || data.confidence_limited === true;
  $("pressureMode").textContent = bounded
    ? "BOUNDARY"
    : (lowConfidence ? "LOW CONFIDENCE" : (hasPressureSignal ? (forceAvailable ? "LIVE GRID" : "RELATIVE GRID") : (points.length ? "NO CONTACT" : "WAITING")));
  const totalForce = points.reduce((sum, point) => sum + point.force, 0);
  $("pressureDetail").textContent = bounded
    ? "OOD / BOUNDARY ESTIMATE"
    : (lowConfidence
      ? `${points.length} CELLS / ESTIMATE ONLY`
      : (hasPressureSignal ? (forceAvailable ? `${points.length} CELLS / ${totalForce.toFixed(2)} N` : `${points.length} CELLS / RELATIVE DEFORMATION`) : "NO CONTACT GRID"));
  $("pressureMessage").hidden = points.length > 0;
  if (!points.length) $("pressureMessage").textContent = forceStatus(data) === "no_contact" ? "No contact distribution" : "Waiting for pressure distribution";
}

function drawHistory(data) {
  const canvas = $("historyCanvas");
  const { context, width, height } = setCanvasSize(canvas);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0e161f";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "#20303d";
  context.lineWidth = 1;
  for (let y = 28; y < height; y += 34) {
    context.beginPath();
    context.moveTo(8, y);
    context.lineTo(width - 8, y);
    context.stroke();
  }
  const history = Array.isArray(data.history) ? data.history : [[], [], []];
  const colors = ["#5bbdff", "#aa91ff", "#f2b667"];
  history.slice(0, 3).forEach((axisValues, axis) => {
    if (!Array.isArray(axisValues) || axisValues.length < 2) return;
    const values = axisValues.slice(-80).map((value) => finiteNumber(value));
    const scale = Math.max(2, ...values.map((value) => Math.abs(value)));
    context.strokeStyle = colors[axis];
    context.lineWidth = 2;
    context.beginPath();
    values.forEach((value, index) => {
      const x = 8 + index * (width - 16) / Math.max(1, values.length - 1);
      const y = height / 2 - value / scale * (height * .35);
      if (index) context.lineTo(x, y);
      else context.moveTo(x, y);
    });
    context.stroke();
  });
}

function updateTelemetry(data, sequence) {
  const force = asTriplet(data.force_N);
  const contact = asTriplet(data.contact_mm);
  const status = forceStatus(data);
  const estimateVisible = data.force_estimate_available === true
    || status === "valid" || status === "bounded_ood" || status === "low_confidence";
  $("fx").textContent = estimateVisible ? signed(force[0]) : "--";
  $("fy").textContent = estimateVisible ? signed(force[1]) : "--";
  $("fz").textContent = estimateVisible ? signed(force[2]) : "--";
  $("cx").textContent = estimateVisible ? signed(contact[0]) : "--";
  $("cy").textContent = estimateVisible ? signed(contact[1]) : "--";
  $("cz").textContent = estimateVisible ? signed(contact[2]) : "--";

  const confidence = Number(data.confidence);
  $("confidence").textContent = Number.isFinite(confidence) ? confidence.toFixed(2) : "--";
  const inferenceFps = finiteNumber(data.inference_fps ?? data.fps, NaN);
  $("fps").textContent = Number.isFinite(inferenceFps) && inferenceFps > 0 ? `${inferenceFps.toFixed(1)} INFERENCE FPS` : "-- INFERENCE FPS";
  const cameraFps = finiteNumber(data.camera_fps, NaN);
  $("captureFps").textContent = Number.isFinite(cameraFps) && cameraFps > 0 ? cameraFps.toFixed(1) : "--";
  $("frameSequence").textContent = sequence >= 0 ? `FRAME ${sequence}` : "FRAME --";
  $("flowFrameSeq").textContent = sequence >= 0 ? sequence : "--";
  $("pressureFrameSeq").textContent = sequence >= 0 ? `FRAME ${sequence}` : "FRAME --";
  const serverLatency = finiteNumber(data.processing_latency_ms, NaN);
  const captureMs = finiteNumber(data.capture_timestamp_ns, 0) / 1e6;
  const presentationLatency = captureMs > 0 ? Math.max(0, Date.now() - captureMs) : NaN;
  if (Number.isFinite(presentationLatency) && presentationLatency < 5000) {
    runtime.presentationLatencies.push(presentationLatency);
    runtime.presentationLatencies = runtime.presentationLatencies.slice(-120);
  }
  const serverP95 = finiteNumber(data.processing_latency_p95_ms, serverLatency);
  const p95Presentation = runtime.presentationLatencies.length ? percentile(runtime.presentationLatencies, 0.95) : NaN;
  $("latencyDetail").textContent = Number.isFinite(serverP95) && Number.isFinite(p95Presentation)
    ? `P95 ${p95Presentation.toFixed(0)} MS / CORE ${serverP95.toFixed(0)} MS`
    : (Number.isFinite(serverP95) ? `CORE P95 ${serverP95.toFixed(0)} MS` : "P95 -- MS");

  const diagnostics = data.diagnostics && typeof data.diagnostics === "object" ? data.diagnostics : {};
  const rawConfidence = finiteNumber(diagnostics.raw_confidence, NaN);
  const flowP90 = finiteNumber(diagnostics.flow_p90, NaN);
  const signal = diagnostics.signal_present === true ? "ON" : (diagnostics.signal_present === false ? "OFF" : "--");
  $("diagnostic").textContent = `confidence ${Number.isFinite(rawConfidence) ? rawConfidence.toFixed(2) : "--"}  /  flow p90 ${Number.isFinite(flowP90) ? flowP90.toFixed(2) : "--"}  /  signal ${signal}  /  ${status.toUpperCase()}`;

  const computeMode = typeof data.backend === "string" ? data.backend : (typeof data.processing_mode === "string" ? data.processing_mode : (typeof data.inference_mode === "string" ? data.inference_mode : "CPU FARNEBACK / 2 WORKERS"));
  $("inferenceMode").textContent = computeMode.toUpperCase();
  const locked = data.camera_config && data.camera_config.lock_summary;
  const unsupported = data.camera_config && Array.isArray(data.camera_config.unsupported_properties)
    ? data.camera_config.unsupported_properties.length : 0;
  const unlocked = data.camera_config && Array.isArray(data.camera_config.unlocked_properties)
    ? data.camera_config.unlocked_properties.length : 0;
  $("cameraConfig").textContent = locked === "locked"
    ? "CAMERA CONFIG LOCKED"
    : (locked ? `CAMERA CONFIG PARTIAL ${unsupported + unlocked} UNAVAILABLE` : "CAMERA CONFIG --");
  const bounded = isBounded(data);
  const lowConfidence = status === "low_confidence" || data.confidence_limited === true;
  ["forceCardFx", "forceCardFy", "forceCardFz"].forEach((id) => {
    $(id).classList.toggle("bounded", bounded);
    $(id).classList.toggle("low-confidence", lowConfidence && !bounded);
  });
  const validation = $("forceStatus").parentElement;
  validation.classList.toggle("is-bounded", bounded);
  validation.classList.toggle("is-low-confidence", lowConfidence && !bounded);
  $("forceStatus").textContent = bounded
    ? "BOUNDARY ESTIMATE / OUT OF TRAINING DOMAIN"
    : (lowConfidence
      ? "LOW CONFIDENCE ESTIMATE / NOT A VALID MEASUREMENT"
      : (status === "optical_contact_unquantified" ? "OPTICAL CONTACT / FORCE UNAVAILABLE" : "CALIBRATION MODEL / RUNTIME CONTRACT"));
  $("validityNote").textContent = bounded
    ? "Distribution remains visible; force is bounded, not a valid absolute measurement"
    : (lowConfidence
      ? "Force and grid remain visible; confidence is below the validity threshold"
      : (status === "optical_contact_unquantified" ? "Relative deformation remains visible; an accepted force estimate is required for N/cell" : (measurementValid(data) ? "E75 labels / measurement valid within training domain" : "E75 labels / research validation only")));

  const defaultStatusClass = bounded ? "ood" : (status === "valid" ? "live" : (lowConfidence ? "low_confidence" : "waiting"));
  setStatus(data.status_class || defaultStatusClass, data.status_text || (bounded ? "OUT OF TRAINING DOMAIN" : (status === "valid" ? "LIVE" : (lowConfidence ? "LOW CONFIDENCE ESTIMATE" : (status === "optical_contact_unquantified" ? "CONTACT DETECTED - FORCE UNAVAILABLE" : "WAITING FOR CONTACT")))));
}

function commitPacket(packet) {
  const { data, sequence, imageUrl } = packet;
  runtime.lastCommittedData = data;
  runtime.lastCommittedSeq = Math.max(runtime.lastCommittedSeq, sequence);
  $("flowShell").dataset.frameSeq = String(sequence);
  $("pressureShell").dataset.frameSeq = String(sequence);
  if (imageUrl) $("frame").src = imageUrl;
  $("frameMessage").hidden = Boolean(imageUrl);
  if (!imageUrl) $("frameMessage").textContent = "Waiting for camera";
  updateTelemetry(data, sequence);
  drawField(data);
  drawPressureGrid(data);
  drawHistory(data);
}

function decodedFrame(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = async () => {
      try {
        if (typeof image.decode === "function") await image.decode();
      } catch (_) {
        // A cached image may complete before decode() is ready; onload is still usable.
      }
      resolve(url);
    };
    image.onerror = () => reject(new Error("frame image request failed"));
    image.src = url;
  });
}

function animationFrame() {
  return new Promise((resolve) => window.requestAnimationFrame(resolve));
}

function packetSuperseded(packet) {
  if (!runtime.pendingPacket) return false;
  return runtime.pendingPacket.token > packet.token && runtime.pendingPacket.sequence >= packet.sequence;
}

async function applyLatestPacket() {
  if (runtime.applyingPacket || !runtime.pendingPacket) return;
  const packet = runtime.pendingPacket;
  runtime.pendingPacket = null;
  runtime.applyingPacket = true;
  let imageUrl = null;
  try {
    const shouldLoadFrame = Boolean(packet.data.frame_ready) && packet.sequence >= 0 && packet.sequence !== runtime.lastCommittedSeq;
    if (shouldLoadFrame) imageUrl = await decodedFrame(`/api/frame.jpg?seq=${encodeURIComponent(packet.sequence)}`);
    if (packetSuperseded(packet)) return;
    await animationFrame();
    if (packetSuperseded(packet)) return;
    commitPacket({ ...packet, imageUrl });
  } catch (error) {
    if (!packetSuperseded(packet)) {
      // RGB and overlays are an atomic visual unit.  A cache-evicted JPEG must
      // never leave a newer vector/pressure frame painted over an older image.
      setTransport("FRAME RESYNC");
      void requestLatestState();
    }
  } finally {
    runtime.applyingPacket = false;
    if (runtime.pendingPacket) void applyLatestPacket();
  }
}

async function requestLatestState() {
  if (runtime.resyncing) return;
  runtime.resyncing = true;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("fresh state request failed");
    parseAndQueue(await response.text());
  } catch (_) {
    $("frameMessage").textContent = "Resynchronizing live frame";
    $("frameMessage").hidden = false;
  } finally {
    runtime.resyncing = false;
  }
}

function queueState(data) {
  if (!data || typeof data !== "object") return;
  const sequence = normalizeFrameSeq(data);
  if (sequence < runtime.lastCommittedSeq) return;
  if (runtime.pendingPacket && sequence < runtime.pendingPacket.sequence) return;
  runtime.pendingPacket = { data, sequence, token: ++runtime.nextPacketToken };
  void applyLatestPacket();
}

function parseAndQueue(raw) {
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    queueState(parsed && parsed.state && typeof parsed.state === "object" ? parsed.state : parsed);
  } catch (_) {
    setTransport("STREAM PAYLOAD ERROR");
  }
}

function clearSseTimers() {
  if (runtime.sseTimeout) window.clearTimeout(runtime.sseTimeout);
  if (runtime.sseRetryTimer) window.clearTimeout(runtime.sseRetryTimer);
  runtime.sseTimeout = null;
  runtime.sseRetryTimer = null;
}

function stopPolling() {
  runtime.polling = false;
  if (runtime.pollTimer) window.clearTimeout(runtime.pollTimer);
  runtime.pollTimer = null;
}

function scheduleSseRetry() {
  if (runtime.sseRetryTimer) return;
  runtime.sseRetryTimer = window.setTimeout(() => {
    runtime.sseRetryTimer = null;
    if (runtime.polling) startEventStream();
  }, 10000);
}

async function pollOnce() {
  if (!runtime.polling) return;
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("state request failed");
    parseAndQueue(await response.text());
    setTransport("POLLING FALLBACK");
  } catch (_) {
    setTransport("SERVER UNAVAILABLE");
    setStatus("error", "SERVER UNAVAILABLE");
    $("frameMessage").textContent = "Waiting for local service";
    $("frameMessage").hidden = false;
  } finally {
    // SSE is the normal transport.  This slow retry is only for browsers or
    // local proxies that cannot keep an event stream open.
    if (runtime.polling) runtime.pollTimer = window.setTimeout(pollOnce, 500);
  }
}

function startPolling() {
  if (runtime.polling) return;
  runtime.polling = true;
  setTransport("POLLING FALLBACK");
  void pollOnce();
  scheduleSseRetry();
}

function fallbackToPolling() {
  if (runtime.eventSource) runtime.eventSource.close();
  runtime.eventSource = null;
  runtime.sseReady = false;
  if (runtime.sseTimeout) window.clearTimeout(runtime.sseTimeout);
  runtime.sseTimeout = null;
  startPolling();
}

function startEventStream() {
  clearSseTimers();
  stopPolling();
  if (!("EventSource" in window)) {
    startPolling();
    return;
  }
  if (runtime.eventSource) runtime.eventSource.close();
  runtime.sseReady = false;
  setTransport("CONNECTING STREAM");
  const source = new EventSource("/api/events");
  runtime.eventSource = source;
  const receiveEvent = (event) => {
    if (runtime.eventSource !== source) return;
    runtime.sseReady = true;
    if (runtime.sseTimeout) window.clearTimeout(runtime.sseTimeout);
    runtime.sseTimeout = null;
    setTransport("LIVE STREAM");
    parseAndQueue(event.data);
  };
  source.onmessage = receiveEvent;
  source.addEventListener("frame", receiveEvent);
  source.addEventListener("state", receiveEvent);
  source.onopen = () => {
    if (runtime.eventSource === source) setTransport("STREAM CONNECTED");
  };
  source.onerror = () => {
    if (runtime.eventSource !== source) return;
    fallbackToPolling();
  };
  runtime.sseTimeout = window.setTimeout(() => {
    if (runtime.eventSource === source && !runtime.sseReady) fallbackToPolling();
  }, 3000);
}

$("recalibrate").addEventListener("click", async () => {
  const button = $("recalibrate");
  button.disabled = true;
  try {
    const response = await fetch("/api/recalibrate", { method: "POST" });
    if (!response.ok) throw new Error("recalibrate request failed");
  } catch (_) {
    setStatus("error", "RECALIBRATE FAILED");
  } finally {
    window.setTimeout(() => { button.disabled = false; }, 400);
  }
});

window.addEventListener("resize", () => {
  if (runtime.resizeQueued) return;
  runtime.resizeQueued = true;
  window.requestAnimationFrame(() => {
    runtime.resizeQueued = false;
    drawField(runtime.lastCommittedData);
    drawPressureGrid(runtime.lastCommittedData);
    drawHistory(runtime.lastCommittedData);
  });
});

window.addEventListener("beforeunload", () => {
  if (runtime.eventSource) runtime.eventSource.close();
  stopPolling();
  clearSseTimers();
});

drawField(DEFAULT_DATA);
drawPressureGrid(DEFAULT_DATA);
drawHistory(DEFAULT_DATA);
startEventStream();

