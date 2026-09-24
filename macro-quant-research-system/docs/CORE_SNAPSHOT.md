# Core snapshot boundary

Included: React/TypeScript renderer, Electron security/IPC source for review, lockfile, and frontend tests.

Excluded: FastAPI backend, credentials, databases, market data, logs, and model assets. `npm run check`, `npm test`, and `npm run build` validate the renderer snapshot; the UI requires the original local backend for live records. `npm run dev` starts the renderer only.

