# Shenmen Pulse-Diagnosis Watch

I build research-driven products at the boundary of physical sensing, machine learning, and reliable software.

## The problem

The project explores whether a localized optical pulse-wave and contact-force workflow can make repeatable measurements around the HT7/Shenmen region without pretending to be a clinical diagnostic device.

## What I personally built

I independently completed the initial hardware and software design for the pulse-diagnosis watch. I am the first inventor named on the related invention and utility-model patent applications; both applications are currently under substantive examination.

The software prototype includes a multi-channel raw-data interface, pressure-step acquisition, signal preprocessing, beat segmentation, pulse morphology features, and a report workflow. The companion Windows research tool records A201 contact-force and pulse-wave signals, keeps control paths manual and attended, and preserves explicit research-only boundaries.

## The hardest constraint

The system must separate a measurable local pulse-wave workflow from clinical interpretation. The source design therefore requires timestamped samples, saturation and motion rejection, force-quality checks, consent/ethics controls for human research, and no diagnosis output.

## Key decisions

- Keep pressure mapping manual and research-only rather than silently turning it into an automatic medical control loop.
- Define the device as a local HT7 optical pulse-wave prototype, not the classical six-position pulse or a diagnostic instrument.
- Preserve a hard boundary between engineering evidence and clinical validation.

## Results and current status

The workspace contains historical hardware/protocol smoke evidence and a historical manual pressure-mapping report. These are useful engineering records, not current acceptance certificates. The software README and design specification provide a reproducible prototype scope.

## What I learned

Measurement claims become safer when the acquisition contract, operator workflow, and non-diagnostic boundary are written before adding interpretation.

## What remains unresolved

Public application identifiers and official registry links will be added after the public records are supplied and verified. Clinical validity, mass production, and commercial proof are not claimed. Current hardware acceptance was not rerun during this portfolio pass.

## Artifacts

- `README.md` and `docs/contribution_questions.md` in this draft repository.
- Source evidence is indexed in the portfolio delivery package's `evidence/source_manifest.json`.
- Public repository and patent links: pending user confirmation.

## Draft and licensing status

This repository is a sanitized portfolio draft, not a complete runnable source distribution. Review and replace license metadata only after ownership and third-party permissions are confirmed. Source repositories, licensed data, unpublished materials, and collaborators' work remain under their existing terms.
## Runnable core snapshot

This public-safe snapshot contains the signal-processing package and a synthetic-data path only. It excludes CAD/PCB/BOM, firmware and device-specific design details, patent drafts, and measured sessions.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m shenmen_pulse.simulate --out examples\generated_session.csv
python -m shenmen_pulse.analyze examples\generated_session.csv --out examples\generated_report.json
python -m shenmen_pulse.report examples\generated_report.json --out examples\generated_report.md
python -m unittest discover -s tests
```

All generated data are synthetic and are not human measurements or evidence of clinical validity. See `docs/CORE_SNAPSHOT.md` for the included-file boundary.


