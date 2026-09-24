# Yin-Yang 25 Research Survey

## The problem

The project turns a structured self-report research instrument into a controlled participant flow without exposing the questionnaire source bundle, administrative data, or private runtime state through the public listener.

## What I personally built

I built a research-facing self-report instrument with a minimal public contract, consent and CSRF controls, session recovery, rate/retention rules, and a separate loopback-only administrative path. The deployment design keeps production data, secrets, logs, QR artifacts, and backups outside the source repository.

## The hardest constraint

The public experience must remain useful while the system refuses to become a medical or psychological diagnostic service. Evidence-insufficient results remain suppressed, and production QR distribution stays behind a release checklist.

## Key decisions

- Serve only the minimum public endpoints and never expose the source questionnaire bundle as a static asset.
- Require affirmative adult confirmation and consent before writing session/answer data.
- Put public and administrative listeners on separate loopback ports and require an edge with HTTPS for public traffic.
- Treat DNS, mobile reachability, load, backup restoration, and retention as deployment gates rather than assumptions.

## Results and current status

The repository documents the contract, security model, operations notes, and release checklist. It is not represented as a live production service in this draft. The release checklist remains the authority for any future QR or public-domain claim.

## What I learned

Privacy is an end-to-end boundary: route allowlists, consent-before-write, session recovery, storage retention, cache headers, deployment edge, and operational recovery must agree.

## What remains unresolved

No real responses, production database, admin token, QR artifact, DNS proof, mobile acceptance, or public deployment assertion is included.

## Artifacts

- `README.md` and `docs/contribution_questions.md` in this draft repository.
- Sanitized security and release evidence is indexed in the portfolio delivery package.
- Public service URL: pending release-checklist completion and user confirmation.

## Draft and licensing status

This repository is a sanitized portfolio draft, not a complete runnable source distribution. Review and replace license metadata only after ownership and third-party permissions are confirmed. Source repositories, licensed data, unpublished materials, and collaborators' work remain under their existing terms.

## Runnable core snapshot

The public-server security, storage, and HTTP modules plus their isolated tests are included. The assessment source bundle, administrator UI, runtime configuration/secrets, invite codes, databases, and production records are intentionally excluded.

The isolated security test suite runs without the excluded instrument. The HTTP integration test imports `createAssessment` and requires an authorized instrument source bundle, so that integration suite remains unavailable in this sanitized snapshot. Syntax checks and the isolated test are safe to run:

```powershell
node --check src/http.mjs
node --check src/store.mjs
node --check src/security.mjs
node --check src/config.mjs
node --check src/assessment.mjs
node --check public/app.js
npm test
```

Do not configure a real campaign or collect responses with this snapshot. It is not a deployable questionnaire service without the separately controlled instrument, security review, and release checklist.



