# Testing and QA

DUIT has three layers of checks: fast unit/integration tests, browser end-to-end
checks, and disposable data scripts for QA and performance smoke tests. None of
them write to the live database at `server/data/todo.db`.

## Automated checks

| Command | What it runs |
| --- | --- |
| `npm run lint` | ESLint over the server, frontend, scripts and tests. |
| `npm test` | Node's test runner over `server/**/*.test.ts`, `src/**/*.test.ts` and `src/**/*.test.tsx` using `.env.test`. |
| `npm run build` | `tsc -b` followed by the Vite production build. |
| `npm run test:e2e` | Builds the app, starts an isolated server, and runs two Chrome browser flows. |

These first three commands are also the CI checks in `.github/workflows/ci.yml`
on every push and pull request. CI uses Node 22; the app itself needs Node 22.5+
for `node:sqlite`.

### Unit and integration tests

`npm test` covers API routes, authentication, teams, tasks, notifications, the
ML pipeline, parsers and React components. It uses `.env.test`, so SQLite is
pointed at a throwaway test database. Tests do not call external services.

### Browser tests

`npm run test:e2e` uses Playwright with the installed **Chrome** channel
(`channel: 'chrome'`), so Playwright never downloads a browser. The config in
`playwright.config.ts` starts `node --import tsx server/start.ts` on port 3101
with:

- `DUIT_DB_PATH=./server/data/todo.e2e.db` — an isolated SQLite file
- `NODE_ENV=development` — keeps the session cookie usable over plain HTTP
- `ML_DISABLE_SCHEDULER=1` — stops background retraining during a run

The two specs in `e2e/app.spec.ts` verify:

1. Signup, task creation through the dialog, completion, sign-out and sign-in.
2. Team creation, invitation acceptance, task assignment, `@mention` comments,
   and the resulting in-app notifications for the teammate.

Traces and failure screenshots are written to `test-results/` only when a test
fails. That directory, along with `playwright-report/` and `blob-report/`, is
git-ignored.

Browser tests are local by default because they require installed Chrome. Add a
Chrome installation step to CI before adding `npm run test:e2e` there.

## Disposable data scripts

| Command | Env file | Purpose |
| --- | --- | --- |
| `npm run qa:reset` | `.env.qa` | Delete `server/data/todo.qa.db` and its WAL/SHM files. |
| `npm run qa:seed` | `.env.qa` | Seed two users, a team, three open team tasks (one assigned, one with a mention comment), a personal task and a completed task. |
| `npm run demo:team` | main app DB | Rebuild a synthetic multi-team fixture (history, subtasks, assignees, notes, invites) only on the separate demo accounts. |
| `npm run perf:check` | `.env.perf` | Seed 5,000 tasks in `todo.perf.db` and report bootstrap timings. |
| `npm run docs:screenshots` | `.env.screenshots` | Regenerate the README images in `docs/screenshots/` from a fresh fixture. |

`qa-reset.ts` refuses paths that do not end in `.qa.db`, `.perf.db` or
`.test.db` unless `QA_ALLOW_RESET=1` is set explicitly. All three env files
point at disposable databases under `server/data/`.

### QA fixture

After `npm run qa:seed`:

- `qa-lead@example.com` / `qa12345` — team host
- `qa-mate@example.com` / `qa12345` — team member
- Team: **QA Crew**

This is useful for manually checking invites, assignments, mention notifications
and the completed column without creating real accounts.

### Rich team demo fixture

`npm run demo:team` rebuilds the same shared fixture in the main app DB, but only
for the demo accounts (`ml-demo@example.com`, `ml-demo-mate@example.com` and
`ml-demo-priya@example.com`, all `demo12345`). The lead sees **Launch Crew**,
**Product Release** and **Ops Hub**, plus a pending invitation to **Design Guild**.
The fixture includes completed work from previous days, tasks with multiple
assignees, per-subtask owners, notes with `@mentions`, pending sends and incoming
invites. Re-running the script replaces only these prefixed demo teams.

### Performance smoke test

`npm run perf:check` creates 5,000 tasks in a fresh `todo.perf.db`, then calls
the same bootstrap and notification functions used by `/api/bootstrap`. A local
run reported:

- bootstrap: **80.1 ms**
- `notificationsFor`: **1.5 ms**
- tasks returned: **5,000**
- notifications returned: **0**

These numbers are a regression smoke test on one machine, not a benchmark or a
promise for every device. Run it after changes that touch bootstrap queries or
notification derivation.

## Screenshots

The images embedded in the README come from `npm run docs:screenshots`. The
script resets `todo.screenshots.qa.db`, seeds tasks due today, starts the built
app on port 3102 with installed Chrome, and captures:

| File | View |
| --- | --- |
| `docs/screenshots/board.png` | My tasks board and completed column |
| `docs/screenshots/teams.png` | Teams view with multiple shared teams, tasks and invitations |
| `docs/screenshots/task-details.png` | Task details with assignee and `@mention` comment |
| `docs/screenshots/notifications.png` | In-app assignment and mention notifications |

The fixture data is synthetic. It is stored only in the disposable screenshot
database, and the check-in prompt is skipped through the API so each capture is
repeatable.

## Manual browser pass

After a UI change, a short manual pass should still check:

- a new account can sign up, skip the check-in, create a task and complete it;
- a host can create a team, invite a member and see **Pending** in team settings;
- the member can accept the invite and sees assignment/mention notifications;
- narrow layouts reflow the board and keep the header **Add task** action reachable;
- no wording claims real-world prediction accuracy (the only label is
  `Chance you'll work on it today`).
