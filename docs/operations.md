# Operations

**Purpose.** How to run the app, train and retrain models, read the model health view, roll back a model, and control logging.

**Where in the code**

- `package.json` — the npm scripts
- `server/index.ts` — the server, route mounting and the retrain scheduler
- `server/ml/learning.ts` — the retrain gate, rate limit and scheduler
- `server/ml/registry.ts` — promotion and rollback
- `server/ml/health-routes.ts` — the `/api/ml` endpoints
- `server/ml/logging.ts` — local logging
- `server/ml/synthetic/cli.ts` — the synthetic training commands
- `.env.test` — the test runner's TypeScript config

## Requirements

- **Node.js 22.5+** (the app uses the built-in `node:sqlite` module).
- No external services. No mail service, no ML service, no database server.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3001` | The API port |
| `ML_DISABLE_SCHEDULER` | unset | `1` turns off the periodic retraining scheduler |
| `ML_RETRAIN_EVERY_MS` | `21600000` (6 h) | How often the scheduler asks the retrain gate |
| `ML_LOG_FILE` | unset | When set, learning log lines are also appended to this file (local only) |

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies |
| `npm run dev` | API (`tsx watch server/index.ts`) + Vite dev server |
| `npm run dev:api` | API only (port 3001) |
| `npm run dev:web` | Vite only (port 5173) |
| `npm run build` | Type-check (`tsc -b`) and build the frontend |
| `npm start` | Serve the built app and API on port 3001 |
| `npm test` | Run the whole test suite (server + frontend) |
| `npm run seed:sample` | Load a small sample dataset for local testing |
| `npm run seed:purge` | Remove the sample dataset |
| `npm run synthetic:generate` | Generate the synthetic dataset |
| `npm run synthetic:reload` | Load the synthetic dataset into its sandbox |
| `npm run synthetic:report` | Run the evaluation harness |
| `npm run synthetic:train` | Train models in the sandbox |
| `npm run synthetic:asof` | Rebuild the synthetic data as of a cutoff |
| `npm run synthetic:purge` | Delete the synthetic dataset |

Server-only type-check (useful when a full build is not wanted):

```bash
node node_modules/typescript/bin/tsc -b
```

On Windows PowerShell, `npm` may be blocked by execution policy. Run the underlying Node
command directly, for example:

```bash
node --env-file=.env.test --import tsx --test "server/**/*.test.ts" "src/**/*.test.ts" "src/**/*.test.tsx"
```

## Training instructions

There are two training paths, and they share the same code.

**1. Real data (your own records).** There is no separate CLI. Training runs through the
retrain gate:

- Automatically, when the scheduler is on (`npm run dev` / `npm start`).
- On demand: `POST /api/ml/retrain` (rate-limited), or `POST /api/ml/retrain` with `{"force": true}` to bypass the rate limit.
- The gate trains only when at least 20 new labelled observations have accumulated (configurable) or a model is stale (30 days), and never more than once every 6 hours.

To try the app locally with a small sample dataset first:

```bash
npm run seed:sample
```

**2. Synthetic data (sandbox only).** Use the CLI:

```bash
node --import tsx server/ml/synthetic/cli.ts generate
node --import tsx server/ml/synthetic/cli.ts reload
node --import tsx server/ml/synthetic/cli.ts train --fresh --promote
```

`train` flags: `--promote` runs the promotion gate, `--fresh` clears the sandbox registry
first, `--seed N` sets the seed, `--folds N` sets the validation folds, `--commit SHA` records
a git commit. Candidates registered in the sandbox are marked `synthetic = 1`, so the
promotion gate refuses to serve them in the real app.

## Reading the model health view

```bash
GET /api/ml/health
```

Returns the active model per kind, when each last trained, the labelled-day counts, and
whether the baseline is being used (with a plain-words reason). It re-evaluates the rolling
health before answering. It is informational and never nags.

Related endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /api/ml/health` | Active models, last retrain, counts, fallback state |
| `GET /api/ml/drift` | Recent-vs-long-term drift and dated configuration changes |
| `GET /api/ml/privacy` | What is kept, what is optional, how to delete |
| `DELETE /api/ml/privacy/checkins` | Delete every check-in and its edit trail (activity is kept) |
| `POST /api/ml/retrain` | Retrain now (rate-limited unless `{"force": true}`) |

## Rollback procedure

Rollback is a **code-level** operation, not an HTTP endpoint. The function is
`rollbackChampion(db, userId, kind, { toVersion? })` in `server/ml/registry.ts`. It restores
the previous version as champion and keeps the newer one as `retired`.

Two automatic safety nets already cover the common case, so a manual rollback is rarely needed:

- **Serving fallback** — if a champion cannot be loaded or returns an invalid score, the Phase 4 baseline is served immediately.
- **Health fallback** — if the served model is worse than the baseline over the recent window, the baseline is used for that kind until a retrain clears the flag.

To roll back manually, call the function against the app database (the same `db` singleton in
`server/db.ts`), then reload the health view. The behaviour is covered by
`server/ml/phase5.test.ts` and the synthetic harness.

## Logging

`server/ml/logging.ts` writes one plain line per event to the console, keeps the last 200 in
memory for the health view, and — only when `ML_LOG_FILE` is set — appends them to that local
file. Nothing is sent anywhere else. A logging failure never becomes a work failure.

## Related docs

- [ml.md](ml.md) — what the models do
- [synthetic-data.md](synthetic-data.md) — the sandbox commands in context
- [privacy-and-limits.md](privacy-and-limits.md) — retention and deletion
