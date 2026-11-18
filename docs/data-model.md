# Data model

**Purpose.** Every database table, what it holds, and the rules that keep a missing value missing and a prediction separate from an outcome.

**Where in the code**

- `server/db.ts` — the app's core tables (users, sessions, teams, tasks, …)
- `server/checkins-store.ts` — the check-in tables
- `server/ml/schema.ts` — the learning system's tables, in four groups: foundation, state, prediction, ML

## Storage

One SQLite file: `server/data/todo.db` (created on first boot, git-ignored). Foreign keys are
on. Every schema function is idempotent and safe to run on every boot, so starting the app
twice changes nothing.

## Table groups

### App core — `server/db.ts`

| Table | Holds |
| --- | --- |
| `users` | Account email and password hash |
| `sessions` | Login sessions (token **hash** only) |
| `password_resets` | Password-reset tokens (hash only) |
| `teams`, `team_members`, `team_invites` | Teams, membership roles, pending invites |
| `tasks` | The task itself: text, done, due, position, progress, priority, tags, recurrence, duration, preferred time. `team_id NULL` means a personal task |
| `subtasks` | Subtasks with position and done |
| `comments` | Task comments |

### Check-ins — `server/checkins-store.ts`

| Table | Holds |
| --- | --- |
| `checkins` | One row per user per day: the nine answers (ordinals 1–5, `NULL` when blank), `skipped`, optional free-text `context` |
| `checkin_history` | An append-only snapshot on every edit, so a mid-day change keeps its timestamp |

### Foundation — `server/ml/schema.ts` (`createFoundationSchema`)

| Table | Holds |
| --- | --- |
| `tags` | Stable tag ids per user; `merged_into_id` points at the surviving tag |
| `tag_history` | Append-only trail of tag create / rename / merge |
| `task_tags` | Current task ↔ tag membership |
| `task_configs` | **Versioned** task configuration: name, category, priority, frequency, target duration, preferred time, active. A change appends a row; old rows are never overwritten |
| `task_config_tags` | The tag set as it stood for one config version |
| `activity_sessions` | Real timed activity: task, local date, start/end, duration, note, source. Several per day allowed |
| `daily_activity_status` | What you explicitly said about a day: `completed` / `partial` / `skipped` / `postponed`, with an optional reason |
| `context_questions` | Optional extra questions, attached to a task or suggested by a tag |
| `session_context` | Answers to extra questions, recorded against a session |

### State layer — `createStateSchema`

| Table | Holds |
| --- | --- |
| `day_reviews` | The single optional evening review per day (one of five answers) |
| `state_prefs` | Display preferences for the summary and estimates |
| `state_suggestion_choices` | Whether a low-capacity suggestion was accepted or dismissed |

### Prediction layer — `createPredictionSchema`

| Table | Holds |
| --- | --- |
| `off_days` | One row per off period: kind (optional), start, end, note |
| `prediction_settings` | Per-user thresholds: reduced-confidence days, exploration share, stage-2 minimum days |
| `predictions` | The prediction **log**: source (baseline / model), model version, check-in state, probabilities, durations, recommended window, confidence, stage, explanation. Written by the server only |
| `prediction_feedback` | Whether a suggestion was shown, exploratory, and followed — stored apart from both predictions and outcomes |

### ML and continuous learning — `createMlSchema`

| Table | Holds |
| --- | --- |
| `ml_models` | One append-only row per trained version: kind, version, status (`candidate` / `champion` / `retired` / `rejected`), data range, counts, feature names, hyperparameters, seed, metrics, git commit, serialised payload |
| `ml_shadow` | A candidate's silent predictions beside the champion's on live days; `label` stays `NULL` until the day is labelled |
| `ml_retrain_state` | Labelled-observation count at the last training, per kind |
| `activity_outcome_links` | One row per (user, task, day): the check-in state that preceded the day, the observed outcome (`performed`, `target_achieved`, `total_minutes`), the tags and priority that applied, and the config version. Recomputed when activity is recorded |
| `ml_health_predictions` | A served model's output beside the baseline's for the same (kind, day, task). `label` is `NULL` until the day's outcome is known |
| `ml_health` | The rolling verdict per (user, kind): Brier/calibration/error for model and baseline, the `fallback` flag and a plain-words reason |
| `ml_retrain_log` | Append-only trail of retrain attempts, used for the rate limit and the health view |

## Relationships (simplified)

```mermaid
erDiagram
  users ||--o{ checkins : "one per day"
  checkins ||--o{ checkin_history : "edit trail"
  users ||--o{ tasks : owns
  tasks ||--o{ activity_sessions : "recorded in"
  tasks ||--o{ daily_activity_status : "explicit day status"
  tasks ||--o{ task_configs : "versioned config"
  task_configs ||--o{ task_config_tags : "tags for a version"
  tags ||--o{ task_tags : "current membership"
  users ||--o{ predictions : "logged for"
  users ||--o{ ml_models : "trained for"
  ml_models ||--o{ ml_shadow : "shadowed by"
  users ||--o{ activity_outcome_links : "check-in beside outcome"
  users ||--o{ ml_health_predictions : "served vs baseline"
  users ||--o{ ml_health : "rolling verdict"
```

## Rules the schema enforces

- **Missing stays missing.** A blank check-in answer is `NULL`, never a neutral value. "No priority" is `NULL`, never `low`. A skipped check-in stores no answers at all.
- **`not_asked` vs skipped.** There is no row at all for a day you never touched; an explicit skip writes a row with `skipped = 1`. The two are different facts.
- **History is kept.** Tags and task configuration are versioned and append-only. Renaming or merging a tag never breaks a past record.
- **A prediction is never an outcome.** Predictions live in `predictions`, `ml_shadow`, `ml_health_predictions`. Outcomes live in `activity_sessions`, `daily_activity_status`, `activity_outcome_links`. The label columns in the ML tables are filled only from observed activity.

## Related docs

- [architecture.md](architecture.md) — how the layers use these tables
- [checkin-and-energy.md](checkin-and-energy.md) — the check-in tables in use
- [predictions.md](predictions.md) — the prediction log and feedback
- [privacy-and-limits.md](privacy-and-limits.md) — retention and deletion
