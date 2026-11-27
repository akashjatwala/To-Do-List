# Operations

**Purpose.** How to run the app, train and retrain the completion model, read the completion health view, roll back the completion champion, seed demo data, control logging, and understand the small performance caches.

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
- `server/statement-cache.ts` — per-connection prepared-statement reuse for ML helpers
- `src/lib/refreshCoalescer.ts` — coalesces rapid bootstrap refreshes
- `vite.config.ts` — React vendor chunk split
- `.env.test` — the test runner's TypeScript config

## Requirements

- **Node.js 22.5+** (the app uses the built-in `node:sqlite` module).
- No external services. No mail service, no ML service, no database server.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3001` | The API port |
| `NODE_ENV` | set to `production` by `npm start` | Marks the production build; session cookies become `Secure` |
| `ML_DISABLE_MODEL_SERVING` | unset | `1` serves only baseline estimates, ignoring the trained completion champion (read at startup; needs a restart) |
| `ML_DISABLE_SCHEDULER` | unset | `1` turns off the periodic retraining scheduler |
| `ML_RETRAIN_EVERY_MS` | `21600000` (6 h) | How often the scheduler asks the retrain gate |
| `ML_LOG_FILE` | unset | When set, learning log lines are also appended to this file (local only) |
| `DUIT_DB_PATH` | unset | Optional database path override, resolved from the current working directory; `.env.test` points tests at an isolated file |

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
| `npm run seed:ml` | Seed repeatable demo history in an isolated database and print the completion-only backtest report |
| `npm run seed:ml:app` | Seed demo history into `server/data/todo.db` and print the completion-only backtest report |

Server-only type-check (useful when a full build is not wanted):

```bash
node node_modules/typescript/bin/tsc -b
```

On Windows PowerShell, `npm.ps1` may be blocked by execution policy. Use `npm.cmd` / `npx.cmd`,
or run the underlying Node command directly, for example:

```bash
node --env-file=.env.test --import tsx --test "server/**/*.test.ts" "src/**/*.test.ts" "src/**/*.test.tsx"
```

## Security

- All responses carry `nosniff`, `X-Frame-Options: DENY`, a restrictive Content-Security-Policy, and a no-referrer policy (`server/security.ts`). Fonts are bundled locally via `@fontsource/baloo-2`, so the CSP allows same-origin styles/fonts (`style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`) and keeps `connect-src 'self' ws: wss:` for the Vite dev WebSocket.
- Login (10 per 15 min per email/IP), signup (5 per IP), password resets (5 per email/IP) and password confirmation/deletion (10 per IP) are rate limited in memory. Behind a proxy, set Express `trust proxy` so client IPs are seen correctly.
- **Forgot password?** uses `POST /api/auth/reset` with just an email, new password and confirmation. There is no mail service or reset code: anyone who knows an email can set a new password for it, so this is a local demo convenience rather than a production-grade identity check. Users can still change passwords from **My Account** while signed in.
- `npm start` uses `server/start.ts` to set `NODE_ENV=production` before loading the app, making session cookies `Secure`.

## Performance and caching

These are internal optimizations. They do not change UI copy, colours, layout, prediction rules, or stored data.

- **Startup path** — `/api/health` and static/SPA assets are served before session lookup. Every other `/api/*` route remains behind the session middleware.
- **Prepared statements** — auth, task and ML query statements are prepared once and reused. ML helpers cache by exact SQL in a `WeakMap` keyed by the `DatabaseSync` connection, so isolated test databases never share statements.
- **Champion artifacts** — parsed completion model payloads are cached per connection and reused while the champion row's id and `updated_at` are unchanged. Promotion, rollback and malformed payloads still fall through to a fresh parse or baseline fallback as before.
- **Bootstrap refreshes** — rapid task mutations share one in-flight bootstrap and schedule one follow-up if more changes arrive. Sign-out and account deletion invalidate any in-flight refresh so stale data cannot repopulate the signed-out screen.
- **Nudge plan loads** — the panel ignores a plan response whose request is no longer current, so an older request cannot overwrite a newer one.
- **Header clock** — the 10-second tick lives in `AppHeader`, not the whole board.
- **Sticky board rendering** — the board is memoized and its open/delete callbacks are stable, so dialog, check-in and toast state changes do not re-render the notes.
- **Frontend bundle** — Vite emits React as a separate chunk so app edits do not invalidate the framework bytes.

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
start. Migration 12 removed old password-reset rows and narrowed `auth_tokens.kind` to `session`;
migration 13 adds the reminder tables; migration 14 adds `assigned_at` and `assigned_by` to
`task_assignees` and backfills them from each task's owner and creation time; migration 15 adds
`completed_at` and `completed_by` to `tasks` without backfilling a completion time. Migration 16 is
data-only: it folds legacy duplicate active tags with the same name into the oldest id using the
existing merge path, so task links, JSON labels and history stay consistent. Migration 17 adds
`tags.deleted_at` for soft deletion and lower-cases legacy tag names and task labels while
preserving every id; identically named tags belonging to different users still stay separate.
Migration 18 keeps the old hide-a-date table for databases that already ran it, migration 19 adds
`task_skip_events`, and migration 20 adds the reason, destination and undo columns those events use
for off-day moves. Migration 21 removes stale `target` and `duration` rows from the ML registry,
shadow, retrain and health tables on older databases; completion rows are untouched. Migration 22
drops the unused `preferred_time` columns from `tasks` and `task_configs`. Migration 23 adds
`undone_by` and `undone_at` so an undone team skip can name the teammate who restored it. Migration
25 removes any leftover reset-code rows and keeps `auth_tokens.kind` narrowed to `session`; the
direct reset form never stores a second token.

## In-app reminders

A pending sticky note in the all-overdue dialog can send a reminder with
`POST /api/tasks/:taskId/remind`. This creates a local record only: no email, push or webhook is
sent. Personal reminders have no recipient; team reminders go to the task's current assignees, or
to every team member when nobody is assigned. The newest scoped reminders are returned in
`bootstrap` and shown in the Overdue card.

## Notification centre

`GET /api/notifications` builds the bell panel from the same local rows: pending invitations,
reminders addressed to the user, your own moves, and a team activity feed of task adds, completions,
comments, assignments, skips, skip undos, off days and team reminders from the user's teams. The
user's own actions are included. Team rows carry the team name, and unread rows use a restrained
indigo style. It never queues a message or contacts an outside service. The assignment route records
who assigned whom and when; migration 14 fills older rows from the task's owner and creation time. Completion
is timestamped only when a task changes to done; migration 15 adds those columns but deliberately
does not backfill old rows. The read marker is browser-local, so clearing site data resets it.

## Training instructions

Completion training runs on your own recorded data, through the retrain gate:

- Automatically, when the scheduler is on (`npm run dev` / `npm start`).
- On demand: `POST /api/ml/retrain` (rate-limited), or `POST /api/ml/retrain` with `{"force": true}` to bypass the rate limit.
- The gate trains only when at least 20 new labelled observations have accumulated (configurable) or the completion model is stale (30 days), and never more than once every 6 hours.

The normal retrain path uses recorded activity only: with too little data the completion trainer
returns the baseline and says so. Target probability and expected duration are baseline/statistical
estimates and are not trained or retrained.

## Model serving

Both prediction routes (`GET /api/predictions/plan` and `GET /api/predictions/task`) go
through one entry point, `server/ml/live-predictor.ts`. For each task it serves the **completion
champion** when it is registered, loadable and healthy; otherwise it falls back to the baseline
completion estimate. Target probability and expected duration remain baseline/statistical
estimates, as does the recommended window from the timing profile. The Nudge card shows the
completion percentage beside each task name, with a bar below. The plain-language explanation
still comes from the baseline; the window is logged with the prediction but is not shown in Nudge.
With no trained completion model in the database, behaviour is identical to the baseline-only app.

To compare the two or disable model serving in an emergency, start the server with
`ML_DISABLE_MODEL_SERVING=1`. This keeps all baseline-only behaviour without changing or
deleting any model data. It is read once at startup, so a restart is needed to toggle it.

## Reading the completion health view

```bash
GET /api/ml/health
```

Returns whether the completion champion is active, when it last trained, the labelled-day counts,
and whether the baseline completion estimate is being used (with a plain-words reason). Health is
scored with Brier and ECE; target probability and expected duration are baseline
estimates with no health verdict. It re-evaluates the rolling health before answering. It is
informational and never nags.

Related endpoints:

| Endpoint | Returns |
| --- | --- |
| `GET /api/ml/health` | Completion champion, last retrain, counts, fallback state |
| `GET /api/ml/drift` | Recent-vs-long-term drift and dated configuration changes |
| `POST /api/ml/retrain` | Retrain now (rate-limited unless `{"force": true}`) |

## Rollback procedure

Rollback is a **code-level** operation, not an HTTP endpoint. The function is
`rollbackChampion(db, userId, kind, { toVersion? })` in `server/ml/registry.ts`. For the
completion kind it restores the previous version as champion and keeps the newer one as `retired`.

Two automatic safety nets already cover the common case, so a manual rollback is rarely needed:

- **Serving fallback** — if the completion champion cannot be loaded or returns an invalid score, the baseline completion estimate is served immediately.
- **Health fallback** — if the served completion model is worse than the baseline over the recent window, the baseline completion estimate is used until a completion retrain clears the flag.
- **Model-serving kill switch** — `ML_DISABLE_MODEL_SERVING=1` restores baseline-only estimates everywhere at once, without touching any model data.

To roll back manually, call the function against the app database (the same `db` singleton in
`server/db.ts`), then reload the health view. The behaviour is covered by
`server/ml/models.test.ts`.

## Demo data and the backtest report

`npm run seed:ml` writes repeatable synthetic history to an isolated database
(`server/data/ml-backtest.db`, recreated on each run); `npm run seed:ml:app` writes it to the app
database (`server/data/todo.db`) for the demo account. By default both generate 365 days of
history with the final 60 days held out; pass `--days 180 --holdout 30` for a smaller run. The
report is **completion-only**: it compares the completion champion against the baseline with
Brier, ECE, ROC-AUC and accuracy, and the champion may be logistic regression or the best
histogram-based boosted-tree challenger. Target probability and expected duration are baseline
estimates and are not part of the model backtest. These numbers describe generated data only;
they are not a claim about your own habits.

For a forward check, add `--through YYYY-MM-DD`. The generator still keeps `days` rows ending on
that date; choose `holdout` so the holdout starts on or after the current day. For example, running
`npm run seed:ml -- --through 2026-12-31 --holdout 36` on 2026-11-26 trains through 2026-11-25 and
scores the generated 2026-11-26 → 2026-12-31 window. Those future outcomes are generated for the
simulation; they are not observed facts.

For an exact calendar range and split, pass `--from`, `--through` and all four window flags:
`--train-from`, `--train-to`, `--test-from` and `--test-to`. `--from` overrides `--days` for the
start, and the four window flags replace the trailing holdout. All window dates must fall inside
the generated history, training must end before testing starts, and neither range may be inverted.
For example:

```bat
npm run seed:ml:app -- --from 2025-01-01 --through 2026-12-31 --train-from 2025-01-01 --train-to 2026-07-31 --test-from 2026-08-01 --test-to 2026-10-30
```

This generates two full years, trains only through 2026-07-31 and scores 2026-08-01 → 2026-10-30.
Generated days outside both windows (here November and December 2026) are written to the demo
account for browsing but are never used by training or evaluation. The promoted champion is also
trained on the training window only, so the app model never sees the test days.

## Logging

`server/ml/logging.ts` writes one plain line per event to the console, keeps the last 200 in
memory for the health view, and — only when `ML_LOG_FILE` is set — appends them to that local
file. Nothing is sent anywhere else. A logging failure never becomes a work failure.

## Related docs

- [ml.md](ml.md) — how the completion model works
- [privacy-and-limits.md](privacy-and-limits.md) — local data and honest limits
