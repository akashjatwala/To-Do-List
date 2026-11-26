# API reference

The app is a single Node/Express server that serves both the built UI and a JSON API.
Everything runs locally; there is no external service.

## Conventions

- Base path: `/api`
- Request and response bodies are JSON.
- Authentication uses the `sid` session cookie set by `/api/auth/login` or `/api/auth/signup`.
  Every route except `/api/auth/signup`, `/api/auth/login` and `/api/health` requires that cookie.
- Successful mutations return `{ "ok": true }` unless a specific object is documented.
- Errors return a JSON body such as `{ "error": "Task not found." }` with the matching HTTP status.
- Dates are local `YYYY-MM-DD` strings. Timestamps are milliseconds since the Unix epoch.
- There is no email, push or webhook delivery anywhere in the API.

## Health and bootstrap

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process health check. Returns `{ "ok": true }`. |
| `GET` | `/api/bootstrap` | All data needed to render the app: user, teams, invites, tasks, notes, reminders, the user's off days and teammates' off days. |
| `GET` | `/api/notifications` | The in-app notification feed, newest first. |

## Auth and account

| Method | Route | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/auth/signup` | `{ email, name, password, remember? }` | Creates the account, sets `sid`, returns `{ user }`. |
| `POST` | `/api/auth/login` | `{ email, password, remember? }` | Sets `sid`, returns `{ user }`. |
| `POST` | `/api/auth/logout` | — | Clears the cookie. |
| `GET` | `/api/auth/me` | — | Returns the signed-in user. |
| `PATCH` | `/api/auth/me` | `{ name }` | Renames the user. |
| `POST` | `/api/auth/password` | `{ currentPassword, newPassword }` | Changes the password and signs out other sessions. |
| `POST` | `/api/auth/sessions/others` | — | Signs out every other device. |
| `DELETE` | `/api/auth/account` | `{ password }` | Deletes the account. Hosts must hand over their teams first. |

Login, signup and password routes are rate-limited.

## Teams and invitations

| Method | Route | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/teams` | `{ name }` | Creates a team; creator becomes host. |
| `PATCH` | `/api/teams/:teamId` | `{ name }` | Host only. |
| `PUT` | `/api/teams/:teamId/host` | `{ memberId }` | Hands the host role to another member. |
| `DELETE` | `/api/teams/:teamId` | — | Host only; deletes the team. |
| `DELETE` | `/api/teams/:teamId/leave` | — | Members only; clears their assignments on that team. |
| `DELETE` | `/api/teams/:teamId/members/:memberId` | — | Host only. |
| `GET` | `/api/teams/:teamId/members` | — | Members only. |
| `POST` | `/api/teams/:teamId/invites` | `{ email }` | Host only; creates a pending invite. |
| `DELETE` | `/api/teams/:teamId/invites/:email` | — | Host only; cancels a pending invite. |
| `GET` | `/api/invites` | — | Invitations addressed to the signed-in user. |
| `POST` | `/api/invites/:teamId/accept` | — | Accepts an invitation. |
| `DELETE` | `/api/invites/:teamId` | — | Declines an invitation. |

## Tasks, subtasks, comments and assignments

| Method | Route | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/api/tasks` | See below | Creates a personal or team task. Returns `{ id }`. |
| `PATCH` | `/api/tasks/:taskId` | Partial task fields | Edits or completes a task. Completing a recurring task rolls it forward. |
| `POST` | `/api/tasks/reorder` | `{ ids: string[] }` | Persists the visible sticky-note order. |
| `POST` | `/api/tasks/:taskId/remind` | — | Creates a local reminder. No external delivery. |
| `POST` | `/api/tasks/:taskId/skip` | `{ date }` | Moves any open note scheduled on `date` (`YYYY-MM-DD`) to the next non-off date. Repeats are not duplicated; team notes notify teammates in-app. |
| `DELETE` | `/api/tasks/:taskId` | — | Creator or team host only. |
| `PUT` | `/api/tasks/:taskId/assignees` | `{ userIds: number[] }` | Replaces team-task assignees. Every id must be a teammate. |
| `POST` | `/api/tasks/:taskId/subtasks` | `{ text, assigneeId? }` | Adds a subtask. |
| `PATCH` | `/api/tasks/:taskId/subtasks/:subtaskId` | `{ text?, done?, assigneeId? }` | Edits a subtask. |
| `DELETE` | `/api/tasks/:taskId/subtasks/:subtaskId` | — | Removes a subtask. |
| `POST` | `/api/tasks/:taskId/comments` | `{ text }` | Adds a comment. `@Name`, `@email` and `@local-part` mentions produce a mention notification for that teammate. |
| `DELETE` | `/api/tasks/:taskId/comments/:commentId` | — | Author or team host only. |

`POST /api/tasks` accepts:

```json
{
  "text": "Submit report",
  "due": 1763932800000,
  "priority": "high",
  "tags": ["work"],
  "recurrence": "none",
  "recurrenceConfig": null,
  "duration": 30,
  "teamId": null
}
```

`priority` is one of `none`, `low`, `medium`, `high`. `duration` is in minutes.
`due` may be `null`.

## Check-ins

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/checkins?date=YYYY-MM-DD` | Returns the status for a date, including `not_asked`, `skipped` or `answered`. |
| `GET` | `/api/checkins/history?limit=30` | Recent check-ins, limit 1–365. |
| `PUT` | `/api/checkins` | Saves answers for a date. All answer keys must be integers 1–5 or `null`. |
| `POST` | `/api/checkins/skip` | Marks the date as skipped. |

Sensitive check-in answers are optional; `null` is kept as missing.

## Learning data and preferences

| Method | Route | Notes |
| --- | --- | --- |
| `GET` / `POST` | `/api/activity/sessions` | List or record time sessions. |
| `DELETE` | `/api/activity/sessions/:id` | Delete one session. |
| `GET` / `PUT` | `/api/activity/day` | Read or replace the daily activity record. |
| `GET` | `/api/activity/day?from=…&to=…` | Date-range view. |
| `DELETE` | `/api/activity/day` | Delete the daily record. |
| `GET` / `POST` | `/api/tags` | List or create user-scoped tags. |
| `PATCH` / `DELETE` | `/api/tags/:id` | Rename or retire a tag. |
| `GET` | `/api/tags/:id` | Read one tag. |
| `GET` | `/api/task-configs/:taskId` | Versioned per-task configuration (target duration). |
| `GET` / `POST` | `/api/context-questions` | Context questions added by the user. |
| `DELETE` | `/api/context-questions/:id` | Remove a context question. |
| `GET` / `PUT` | `/api/state` | Read-only daily state layer. |
| `GET` / `PUT` | `/api/state/prefs` | User preferences. |
| `GET` / `PUT` | `/api/state/review` | Evening review. |
| `PUT` | `/api/state/suggestions` | Suggestion feedback. |
| `GET` / `POST` | `/api/off-days` | List or add off days. Adding one moves open tasks due on those dates to the next non-off date and shows an off-day notice to teammates. |
| `GET` | `/api/off-days/day?date=…` | Off-day status for a date. |
| `PATCH` / `DELETE` | `/api/off-days/:id` | Edit or remove an off day. Task moves are recalculated from the dates still marked off. |
| `GET` / `PUT` | `/api/off-days/settings` | Off-day defaults. |

## Predictions and completion model health

| Method | Route | Notes |
| --- | --- | --- |
| `GET` | `/api/predictions/plan?date=…&today=…` | Day plan, schedule, reschedule ideas and logged predictions. |
| `GET` | `/api/predictions/task?taskId=…&date=…` | Prediction for one personal task. |
| `GET` | `/api/predictions/history?date=…` | Logged predictions for a date. |
| `POST` | `/api/predictions/feedback` | Feedback trail; never an outcome label. |
| `GET` | `/api/predictions/statistics` | Grouped statistics for the current user. |
| `GET` | `/api/ml/health` | Completion champion state, fallback state and labelled-day counts. |
| `GET` | `/api/ml/drift` | Recent-vs-long-term drift and dated configuration changes. |
| `POST` | `/api/ml/retrain` | Retrain the completion model when the gate allows it; `{"force": true}` bypasses the rate limit. |

Prediction routes are personal-only: team tasks are excluded. The UI text for a completion
prediction is `Chance you'll work on it today`. The completion probability comes from the
completion champion when healthy, otherwise from the baseline; target probability and expected
duration are baseline/statistical estimates, not trained models.

See [ml.md](ml.md) for model behaviour and [operations.md](operations.md) for rollback and
maintenance procedures.
