# Gel Tactile Sensing

## The problem

The project explores a camera-based gel tactile sensing workflow that can turn optical deformation into a synchronized, inspectable research estimate while exposing out-of-domain behavior instead of hiding it.

## What I personally built

The hardware platform was developed with my advisor. I built the calibration pipeline, data synchronization, model-serving path, and backend software. The frontend separates RGB/optical-flow and pressure views, exposes frame identity, and marks estimates that are outside the training domain.

## The hardest constraint

The system must not turn a position-grouped cross-validation result into an absolute-force or six-axis metrology claim. The implementation therefore carries model boundaries, contact gating, and `bounded_ood`/invalid-measurement states into the UI.

## Key decisions

- Keep hardware attribution collaborative and explicit.
- Use position-grouped validation rather than random frame splitting.
- Preserve finite but bounded estimates for inspection while marking them invalid for measurement claims.
- Treat independent reference-load and blind tests as release gates.

## Results and current status

The local audit records a research frontend with a documented low-latency window, synchronized panels, and OOD handling. The historical 2026-09-03 live session reports 104 contact frames, all marked `bounded_ood`; that record is not a current accuracy certificate. Independent metrology, blind reference tests, long-run validation, and six-axis equivalence remain open.

## What I learned

A useful research product is not just a model file: the data contract, unit conventions, timing, OOD state, and honest UI semantics are part of the measurement system.

## What remains unresolved

No claim of absolute force accuracy, product-grade contact localization, or six-axis equivalence is made. Raw MCAPs, NPZ datasets, hashes, device imagery, and calibration data stay outside the public repository.

## Artifacts

- `README.md` and `docs/contribution_questions.md` in this draft repository.
- Evidence map: `evidence/source_manifest.json` in the portfolio delivery package.
- Public data/model links: pending redaction and user confirmation.

## Draft and licensing status

This repository is a sanitized portfolio draft, not a complete runnable source distribution. Review and replace license metadata only after ownership and third-party permissions are confirmed. Source repositories, licensed data, unpublished materials, and collaborators' work remain under their existing terms.

## Runnable core snapshot

The copied optical-flow/front-end code is supplied without advisor-owned hardware files, calibration records, raw MCAP/NPZ, or trained model weights. Install the minimal runtime and run the synthetic contract smoke test:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m unittest discover -s tests
```

The smoke test exercises frame resizing, ROI handling, and the relative-deformation fallback. Live camera inference requires separately authorized calibration material and a compatible trained model; this snapshot does not produce validated force measurements.


