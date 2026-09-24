# BTC/ETH Macro-Quant Research System

## The problem

Macro and market signals are easy to show and difficult to audit. This project builds a local research system that keeps point-in-time data, forecast inputs, replay, settlement, audit records, and degraded-readonly behavior visible in one workflow.

## What I personally built

I built the Electron + React/TypeScript desktop client and FastAPI-backed research path represented in the local workspace. The system includes BTC/ETH 1-, 7-, and 30-day forecast views, scenario/replay surfaces, append-oriented audit records, and explicit local-loopback safety boundaries.

## The hardest constraint

Software health is not forecast validity. The system must refuse to turn a working UI, model-list response, or small forward sample into a profitability claim.

## Key decisions

- Keep the first version detached from trading accounts and order creation.
- Keep credentials out of the desktop UI and delegate secret state to the backend's protected store.
- Preserve a historical-distribution baseline mode when model/data admission gates are incomplete.
- Record cutoff and settlement state so later evaluation cannot silently rewrite the past.

## Results and current status

The current system audit documents the architecture and active blockers. The forward audit has only a handful of settled, non-overlapping observations and explicitly says relative advantage is not validated. The system is therefore a research and audit product, not a profitable trading system.

## What I learned

Prediction quality needs its own acceptance chain: point-in-time completeness, model admission, shadow coverage, settlement, calibration, and abstention are separate from application runtime checks.

## What remains unresolved

The current audit still blocks complete minute history, model assets/benchmarks, shadow duration, reviewed event clusters, and adequate non-overlapping settlements. API keys, account data, real trading logs, and paid feeds are excluded.

## Artifacts

- `README.md` and `docs/contribution_questions.md` in this draft repository.
- Sanitized evidence is indexed in the portfolio delivery package.
- Public source/repository URL: pending user confirmation.

## Draft and licensing status

This repository is a sanitized portfolio draft, not a complete runnable source distribution. Review and replace license metadata only after ownership and third-party permissions are confirmed. Source repositories, licensed data, unpublished materials, and collaborators' work remain under their existing terms.

## Runnable frontend snapshot

This snapshot includes the React/TypeScript desktop renderer, Electron security/IPC source for review, and frontend normalization/security tests. The portfolio smoke runs a local static renderer against the real API contract and does not inject fabricated forecasts.

```powershell
cd desktop
npm ci
npm run check
npm test
npm run build
npm run dev
```

The renderer requires the original local FastAPI backend to show live system records; without it the UI reports unavailable state. Backend source, local databases, market data, logs, and credentials are excluded. The Electron shell source is included for review, but this trimmed package builds the web renderer rather than a distributable desktop app.



