# Eddy Yang — Project Portfolio

This repository contains sanitized snapshots of five projects. Each project README describes the problem, my contribution, implementation decisions, available evidence, and limitations.

## Projects

| Project | What to inspect | Snapshot boundary |
|---|---|---|
| [Shenmen Pulse Watch](shenmen-pulse-watch/README.md) | [Signal pipeline](shenmen-pulse-watch/shenmen_pulse/), synthetic generator, analyzer, report writer, and tests | No hardware acquisition stack, measured sessions, CAD, or patent drafts |
| [Gel Tactile Sensing](gel-tactile-sensing/README.md) | [Feature extraction](gel-tactile-sensing/extract_features.py), frontend, browser UI, synthetic smoke test | No calibration dataset, model weights, or advisor-owned hardware files |
| [BTC/ETH Macro-Quant Research System](macro-quant-research-system/README.md) | [React renderer](macro-quant-research-system/desktop/src/), Electron security/IPC, tests | No FastAPI backend, credentials, market database, or model assets |
| [Yin-Yang 25 Research Survey](yy25-research-survey/README.md) | [HTTP/security/storage core](yy25-research-survey/src/), frontend shell, tests | No questionnaire/scoring bundle, admin UI, response data, or deployment config |
| [Mathematical Modeling Reproducibility](mathematical-modeling-reproducibility/README.md) | [Numerical solver](mathematical-modeling-reproducibility/code/), independent synthetic/analytical tests | No organizer prompt/attachments, frozen results, or final paper |

## Run and verify

Follow each project README for environment setup and commands. The included test suites cover software contracts and numerical checks within each snapshot. Some full application flows need private or separately controlled assets and are not runnable from this repository alone.

## Evidence boundaries

These snapshots do not claim clinical validity, force metrology, trading profitability, public service deployment, or reproduction of the competition result. Historical evidence and open limitations are described per project. Personal application statements and motivations are written by the applicant.
