# Testing and QA

DUIT has two layers of checks: fast unit/integration tests and browser
end-to-end checks. Neither writes to the live database at `server/data/todo.db`.

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

Traces and failure artifacts are written to `test-results/` only when a test
fails. That directory, along with `playwright-report/` and `blob-report/`, is
git-ignored.

Browser tests are local by default because they require installed Chrome. Add a
Chrome installation step to CI before adding `npm run test:e2e` there.

## Manual browser pass

After a UI change, a short manual pass should still check:

- a new account can sign up, skip the check-in, create a task and complete it;
- a host can create a team, invite a member and see **Pending** in team settings;
- the member can accept the invite and sees assignment/mention notifications;
- narrow layouts reflow the board and keep the header **Add task** action reachable;
- no wording claims real-world prediction accuracy (the only label is
  `Chance you'll work on it today`).
