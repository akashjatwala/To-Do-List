# DUIT

A focused to-do list app for individuals and small teams, with a private learning
system that runs entirely on your own machine, uses no third-party services, and
predicts what you are realistically likely to get done and suggests suitable times.

Personal lists stay private; teams share tasks, subtasks, and comment threads.
The learning system is a separate layer on top of the existing app: it records what
you actually do, learns from it locally, and sends no personal data to third-party
services.

## Features

**Lists and tasks**

- Email + password accounts with "remember me" sessions
- **My Account** dialog from the account menu: edit your name, change password (other devices get signed out), or delete your account after handing over any teams you host
- Personal to-do lists
- Shared team lists with host/member roles
- Email invitations (accept or decline in-app)
- **Notifications** beside your name collects invitations, reminders, and a recent **Team activity** feed of task adds, completions, comments and assignments — including your own — in one in-app panel; read state is browser-local and nothing is emailed, pushed or webhooked
- Two top-level views — **My tasks** (only your private personal tasks) and **Teams** (team lists; pick a team from the row underneath, and use **New team** to create one)
- A day-by-day board: sticky notes for the selected day, with a calendar picker and prev/next-day controls
- Priority-colored sticky notes — low = soft green, medium = cream, high = soft red
- Drag sticky notes to rearrange them (use the grip on touch); the order is saved and remembered
- Tap a sticky note once to open its task details and edit it (double-click also works on desktop)
- One-tap tags (Work, Personal, Meeting, …) plus custom tags
- An optional ideal duration per task, shown on the note and in task details
- Completed tasks collect in a list on the right, scoped to the same day
- Create personal tasks in **My tasks**, or open a team in **Teams** — new tasks are filed into the list you are viewing
- **Add task** opens a centered dialog. In **My tasks**, the Off days and Today's plan cards sit in the right-hand column above Completed, leaving more room for the notes
- **Quick fill** in the New Task dialog turns “Submit report tomorrow 3pm #work” into a title, due date, preferred time and tag. It also understands weekdays, `next Monday`, `in 3 days`, `25/11/26`, a trailing team name such as `launch crew`, `30m`/`1h` and extra `#tags`; the existing title autocomplete is unchanged
- Recurring tasks (daily, weekly, monthly, or custom weekly weekdays / nth-weekday monthly); completing one automatically creates the next occurrence
- Manual task completion progress (0–100%) with a slider, presets, and list progress bars
- Subtasks with progress tracking
- Task comments
- **Search tasks** between the greeting and the clock: click it to find tasks across the lists you can see by title, tag, person, subtask or comment, with scope/status/priority/due/tag/assignee filters. Notes appear only once you enter a term or choose a filter, and **Clear search** resets both. Typing also suggests task titles from the selected scope, using the same token matching and ranking as New Task; choosing a suggestion fills the field only. Search is local to the loaded board and never calls a prediction model.
- Light-only interface with a soft cream background (`#F8F1E8`) and no theme toggle
- Adaptive layout: the board and side column reflow by window width, with touch-friendly controls on narrow screens

**Learning system (local, no third-party services)**

- A daily check-in (nine optional questions) and an optional evening review
- Activity logging: timed sessions and one-tap per-day statuses (completed / partial / skipped / postponed)
- Per-activity statistics, a readiness/energy view, and similar-day context
- Nudge shows each personal task's chance of finishing today
- Off days (just off / sick / travelling / holiday / other), each with its own emoji, that reduce confidence rather than inventing data
- The **Nudge** card shows only open personal tasks scheduled on the selected day, including repeating occurrences; team tasks and other days are excluded
- Display-only **Worth a look** suggestions. The server still computes the proposed flow, workload warning and "better days" ideas, but they are no longer shown in the UI; none of them change a task's date
- Versioned tags, priority, target duration and preferred time, with full history
- **My Account → Tags** adds, renames and deletes tags; names are always lower case, every task updates immediately, and past history stays linked to the original tag ids
- Local model training, versioning, promotion, rollback and a plain-words model health view
- Trained champions are served for completion, target and duration when healthy; with no model yet, the starting estimates are shown instead
- Continuous learning: recording activity updates statistics immediately and retraining is gated and rate-limited
- Drift notes and dated configuration changes, shown as associations, never as causes
- Privacy controls: everything stays local, and you can delete your check-in history

The prediction numbers and the model behaviour are described in the
[docs](#documentation) below. No accuracy figure is claimed for your own data yet —
see [docs/privacy-and-limits.md](docs/privacy-and-limits.md).

## Quick start

Requires **Node.js 22.5+** (the app uses the built-in `node:sqlite` module).

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. The API runs on <http://localhost:3001>.

### Production

```bash
npm run build
npm start
```

With a built `dist/`, the Express server hosts both the API and the frontend at <http://localhost:3001>.

## How it works

- `server/` — Express 5 API. `db.ts` defines a SQLite schema (users, auth tokens, teams, members, invites, tasks, subtasks, comments); `auth.ts` handles hashed session tokens in the session-only `auth_tokens` table; route files expose `/api/auth`, `/api/teams`, `/api/invites`, `/api/tasks` and `/api/checkins`.
- `server/ml/` — the learning system: data collection, validation, feature engineering, training, evaluation, prediction, continuous learning, model versioning, drift and privacy. See [docs/architecture.md](docs/architecture.md).
- `src/` — React 19 + Tailwind CSS 4 frontend. `App.tsx` loads a single `/api/bootstrap` payload and handles mutations; components live in `src/components/`.
- Data is stored in `server/data/todo.db` (created automatically, git-ignored). The current schema has 36 tables, including the reminder tables; on 2026-11-18 an unused planning/target/weekly scaffold was removed and two pairs of identical tables were merged into `auth_tokens` and `user_settings` (see [docs/data-model.md](docs/data-model.md)).

## Documentation

| Document | What it covers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How the app and the learning system fit together, layer by layer |
| [docs/data-model.md](docs/data-model.md) | Every database table and what it holds |
| [docs/checkin-and-energy.md](docs/checkin-and-energy.md) | The daily check-in, its questions, and the energy/readiness display |
| [docs/predictions.md](docs/predictions.md) | What is predicted, from what inputs, and how it is shown |
| [docs/ml.md](docs/ml.md) | Features, algorithms and why they were chosen, training, versioning, health and drift |
| [docs/operations.md](docs/operations.md) | Running, training, retraining, health checks and rollback |
| [docs/privacy-and-limits.md](docs/privacy-and-limits.md) | What is stored, what stays local, and the honest limits |
| [docs/decisions.md](docs/decisions.md) | The main design choices and their reasons |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | API + Vite dev server with hot reload |
| `npm run build` | Type-check and build the frontend |
| `npm start` | Serve the built app and API on port 3001 |
| `npm run preview` | Preview the Vite build |
| `npm test` | Run the whole test suite (server + frontend) |

## Development notes

- Password changes are made in **My Account**; there is no mail service or reset-code flow.
- Session cookies are `httpOnly` and `Secure` in production; only SHA-256 hashes of session tokens are stored.
- Login, signup and password-confirm endpoints are rate limited, and all responses carry standard security headers.
- Deleting a task requires being its creator or the team host. Comments can be deleted by their author or the host.
- The learning system runs locally only. File logging is opt-in with `ML_LOG_FILE`; nothing is uploaded. See [docs/privacy-and-limits.md](docs/privacy-and-limits.md).
- The retraining scheduler can be turned off with `ML_DISABLE_SCHEDULER=1`, and its interval changed with `ML_RETRAIN_EVERY_MS`. Model serving can be reverted to baseline-only with `ML_DISABLE_MODEL_SERVING=1`. Both are read at startup. See [docs/operations.md](docs/operations.md).
