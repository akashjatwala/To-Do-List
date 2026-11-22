# Operations

**Purpose.** How to run the app, train and retrain models, read the model health view, roll back a model, and control logging.

**Where in the code**

- `package.json` — the npm scripts
- `server/index.ts` — the server, route mounting and the retrain scheduler
- `server/security.ts` — security headers and auth rate limits
- `server/migrations.ts` — versioned schema migrations
- `server/start.ts` — production entry point that sets `NODE_ENV=production`
- `server/ml/learning.ts` — the retrain gate, rate limit and scheduler
- `server/ml/registry.ts` — promotion and rollback
- `server/ml/health-routes.ts` — the `/api/ml` endpoints
- `server/ml/live-predictor.ts` — the single prediction entry point used by the routes
- `server/ml/logging.ts` — local logging
- `.env.test` — the test runner's TypeScript config

## Requirements

- **Node.js 22.5+** (the app uses the built-in `node:sqlite` module).
- No external services. No mail service, no ML service, no database server.

## Installing on a phone (PWA)

The built app is an installable progressive web app. `public/manifest.webmanifest` provides the
name, standalone display mode, theme colours and 192/512 px icons (including maskable variants),
and `public/sw.js` caches the app shell. Registration only happens in production builds.

- Run `npm run build`, then `npm start` to serve the built app on port 3001.
- Open it in a browser on a real phone over **HTTPS** (localhost is exempt). Browsers will not offer
  installation over plain HTTP on a remote host.
- On iOS Safari, tap **Share → Add to Home Screen**. In browsers that fire `beforeinstallprompt`,
  the header's **Install** button offers the native prompt.
- The service worker caches the app shell (HTML, CSS, JS, manifest and icons). API calls are never
  cached, so a cold offline launch shows the app shell but not fresh task data.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3001` | The API port |
| `NODE_ENV` | set to `production` by `npm start` | Marks the production build; session cookies become `Secure` |
| `ML_DISABLE_MODEL_SERVING` | unset | `1` serves only the baseline predictor, ignoring trained models (read at startup; needs a restart) |
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
| `npm start` | Serve the built app and API on port 3001 with `NODE_ENV=production` |
| `npm test` | Run the whole test suite (server + frontend) |

Server-only type-check (useful when a full build is not wanted):

```bash
node node_modules/typescript/bin/tsc -b
```

On Windows PowerShell, `npm` may be blocked by execution policy. Run the underlying Node
command directly, for example:

```bash
node --env-file=.env.test --import tsx --test "server/**/*.test.ts" "src/**/*.test.ts" "src/**/*.test.tsx"
```

## Security

- All responses carry `nosniff`, `X-Frame-Options: DENY`, a restrictive Content-Security-Policy, and a no-referrer policy (`server/security.ts`). The CSP still allows the app's Google Fonts stylesheet and the Vite dev WebSocket.
- Login (10 per 15 min per email/IP), signup (5 per IP) and password confirmation/deletion (10 per IP) are rate limited in memory. Behind a proxy, set Express `trust proxy` so client IPs are seen correctly.
- Password reset codes and `/api/auth/forgot` / `/api/auth/reset` were removed. Users change passwords from **My Account** while signed in.
- `npm start` uses `server/start.ts` to set `NODE_ENV=production` before loading the app, making session cookies `Secure`.

## Database backup

Two pre-change snapshots were archived outside the project during the 2026-11-21
stale-file cleanup; they are no longer in `server/data/`:

- `todo.db.bak-20261118144155` — before the scaffold-table removal
- `todo.db.bak-20261118144721` — before the `auth_tokens` / `user_settings` merges

To restore one, stop the server, copy it over `server/data/todo.db`, then restart. Prefer
`VACUUM INTO '<backup path>'` from a `DatabaseSync` connection over a raw file copy: the database
now runs in WAL mode, so `todo.db-wal` and `todo.db-shm` also hold live state until a clean
checkpoint.

Schema changes are applied by `server/migrations.ts`, which records each version in
`schema_migrations`. The checks are idempotent, so an older database is baselined safely on first
start. Migration 12 removes old password-reset rows and narrows `auth_tokens.kind` to `session`.

## Training instructions

Training runs on your own recorded data, through the retrain gate:

- Automatically, when the scheduler is on (`npm run dev` / `npm start`).
- On demand: `POST /api/ml/retrain` (rate-limited), or `POST /api/ml/retrain` with `{"force": true}` to bypass the rate limit.
- The gate trains only when at least 20 new labelled observations have accumulated (configurable) or a model is stale (30 days), and never more than once every 6 hours.

There is no command that fabricates rows to train on: with too little data each trainer
returns the baseline and says so.

## Model serving

Both prediction routes (`GET /api/predictions/plan` and `GET /api/predictions/task`) now go
through one entry point, `server/ml/live-predictor.ts`. For each task it serves the champion
completion, target and duration numbers when a model is registered, loadable and healthy;
otherwise it falls back to the baseline predictor. The current Nudge card shows only the
completion percentage beside each task name, with a bar below. The recommended time window and
the plain-language explanation still come from the baseline, so timing is unchanged. The window
is logged with the prediction but is not displayed. With no trained model in the database,
behaviour is identical to the baseline-only app.

To compare the two or disable model serving in an emergency, start the server with
`ML_DISABLE_MODEL_SERVING=1`. This keeps all baseline-only behaviour without changing or
deleting any model data. It is read once at startup, so a restart is needed to toggle it.

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

- **Serving fallback** — if a champion cannot be loaded or returns an invalid score, the baseline predictor is served immediately.
- **Health fallback** — if the served model is worse than the baseline over the recent window, the baseline is used for that kind until a retrain clears the flag.
- **Model-serving kill switch** — `ML_DISABLE_MODEL_SERVING=1` restores baseline-only predictions everywhere at once, without touching any model data.

To roll back manually, call the function against the app database (the same `db` singleton in
`server/db.ts`), then reload the health view. The behaviour is covered by
`server/ml/models.test.ts`.

## Logging

`server/ml/logging.ts` writes one plain line per event to the console, keeps the last 200 in
memory for the health view, and — only when `ML_LOG_FILE` is set — appends them to that local
file. Nothing is sent anywhere else. A logging failure never becomes a work failure.

## Related docs

- [ml.md](ml.md) — what the models do
- [privacy-and-limits.md](privacy-and-limits.md) — retention and deletion
