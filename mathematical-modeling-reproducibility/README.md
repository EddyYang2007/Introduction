# Mathematical Modeling Reproducibility

## The problem

A large mathematical modeling competition deliverable should be more than a static paper. It should preserve the model, solver, result tables, figures, evidence, and a clean path for an independent reader to reproduce the frozen numerical outputs.

## What I personally built

I independently built the modeling, solving, validation, and reproducibility pipeline for a large mathematical modeling competition project. The support package includes a formal reproduction entry point, frozen configuration and hashes, code, result workbooks, figures, and physical/numerical evidence reports.

## The hardest constraint

The numerical chain must remain reproducible without silently upgrading conditional model output into experimental truth. The package therefore keeps the input manifest, result hashes, solver checks, and OPEN/UNVERIFIED scientific boundaries together.

## Key decisions

- Keep `reproduce.py` from overwriting frozen results; write new runs to an isolated run directory.
- Preserve independent finite-difference, sensitivity, nonlinear, axisymmetric, and physical checks as evidence rather than hiding them in prose.
- State exactly where historical BDF warnings, material parameters, environmental extension, and shrinkage assumptions remain open.
- Deliver the competition work as a reproducible package, not only a paper PDF.

## Results and current status

The support package and final delivery audit document the formal entry point, frozen hashes, result workbooks, rendered paper checks, and evidence cleanup. The physics report allows conditionally scoped numerical claims but does not claim real-material experiments, global optimality, total-energy closure, or full three-dimensional validity.

## What I learned

Reproducibility is a product surface: a reviewer needs the command, inputs, hashes, outputs, and failure boundaries—not just a polished chart.

## What remains unresolved

Real material properties, long-horizon environment evidence, historical solver-warning localization, and experimental accuracy remain OPEN/UNVERIFIED. Competition attachments and AI-use material require a separate publication/licensing review.

## Artifacts

- `README.md` and `docs/contribution_questions.md` in this draft repository.
- The runnable code in this snapshot is under `code/`; the formal reproduction entry point, competition inputs, frozen results, and paper are excluded.
- Public paper/source links: pending rule, license, and user review.

## Draft and licensing status

This repository is a sanitized portfolio draft, not a complete runnable source distribution. Review and replace license metadata only after ownership and third-party permissions are confirmed. Source repositories, licensed data, unpublished materials, and collaborators' work remain under their existing terms.

## Runnable core snapshot

This snapshot includes the radial numerical solver and a small test suite, but excludes the competition prompt, supplied spreadsheets/data, final paper, and frozen result bundle.

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m pytest code\test_refined_model.py -q
```

The full reproduction entry point is intentionally not copied because it expects organizer-provided input attachments. Solver tests use analytical/synthetic conditions only and do not reproduce the competition result or prove physical validity.





