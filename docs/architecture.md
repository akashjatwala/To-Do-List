# Architecture

**Purpose.** How the web app and the local learning system fit together, layer by layer, and which module owns each job.

**Where in the code**

- `server/index.ts` — Express app, middleware and route mounting
- `server/db.ts` — the SQLite database and the app's core schema
- `server/ml/schema.ts` — the learning system's own tables
- `server/ml/*.ts` — the learning modules (collection, validation, features, training, evaluation, prediction, learning, health, drift, privacy, logging)
- `server/ml/routes.ts`, `prediction-routes.ts`, `state-routes.ts`, `off-day-routes.ts`, `health-routes.ts` — HTTP endpoints
- `src/App.tsx`, `src/api.ts`, `src/components/` — the React frontend

## The three layers

```mermaid
flowchart TD
  UI["React 19 + Tailwind (src/)"] -->|"fetch /api/... (same-origin cookie)"| API["Express 5 API (server/)"]
  API --> DB[("SQLite: server/data/todo.db")]
  API --> ML["Learning modules (server/ml/)"]
  ML --> DB
```

- The **frontend** renders and sends mutations. It never computes a prediction and never writes an outcome. The header clock is a ticking state value, so it stays in sync with the system clock.
- The **API** authenticates the session, validates input, and calls the learning modules.
- The **database** is a single local SQLite file, currently 32 tables after the 2026-11-18 cleanup and table merges described in [data-model.md](data-model.md). The learning system writes only its own tables plus the tables it owns in `server/ml/schema.ts`.

## Board controls

- The greeting row's date is a clickable calendar picker in both **My tasks** and **Teams**, with a **Today** button immediately to its right and hover chevrons to step one day at a time. **Today** is disabled while the selected date is already today; from any other date it returns the board to today. Both boards are scoped to that date, including the progress counter. A repeating task is projected onto each matching future date on either board and also stays in **Repeating**; completing it is one shared edit that rolls the single task forward to the next occurrence (same team, assignees and subtasks). Nudge remains personal-only.
- Both sidebars have an **Overdue tasks** card, in the same visual family as the Teams **Invitations** card. It lists open tasks whose due date has passed, oldest first, with how long ago they were due and three actions: **Open**, **Done** and **Move to today**. My tasks shows only personal tasks; a team board shows only that selected team's tasks and adds **Assigned to** with the current assignees (or **Unassigned**). These are ordinary task edits — they never touch a prediction or write an outcome.
- The **New task** title field shows autocomplete suggestions only after you start typing, drawn from previously created tasks in the selected list and ranked by frequency then recency. Choosing a suggestion only fills the field; it creates nothing by itself and does not call the prediction model.

## The learning pipeline, as separate modules

Each job lives in its own file, so it can be tested and reasoned about alone.

| Job | Module(s) | What it does |
| --- | --- | --- |
| Data collection | `checkins-store.ts`, `ml/sessions.ts`, `ml/daily-activity.ts`, `ml/off-days.ts` | Stores the check-in, timed sessions, per-day statuses and off days |
| Validation | `ml/sessions.ts` (`validateSession`), `checkins-store.ts` (`parseAnswer`, `parseContext`, `parseLocalDate`), `ml/task-config.ts`, `ml/tags.ts` | Rejects invalid or overlapping input; never invents a value |
| Feature engineering | `ml/features.ts`, `ml/dataset.ts` | Builds the one feature vector used by both training and serving |
| Training | `ml/training.ts`, `ml/model/` (`logistic.ts`, `gbm.ts`, `quantile.ts`, `math.ts`), `ml/calibration.ts`, `ml/pipeline.ts` | Trains the candidate models and chooses one |
| Evaluation | `ml/metrics.ts` | Brier score, calibration, duration error |
| Prediction (serving) | `ml/predictors.ts` (baseline), `ml/serving.ts` (champion), `ml/estimates.ts`, `ml/cold-start.ts` | Produces the completion, target and duration estimates; Nudge shows the completion probability (percentage beside the task, bar below) and, when timing history exists, an ideal time from recorded start times; target, duration and confidence stay computed and logged but are not displayed |
| Continuous learning | `ml/learning.ts`, `ml/shadow.ts` | Links recorded activity to outcomes, gates and rate-limits retraining |
| Model versioning | `ml/registry.ts` | Append-only model rows, promotion, rollback, loading |
| Live health & drift | `ml/health.ts`, `ml/drift.ts` | Watches the served model and reports change |
| Privacy & logging | `ml/privacy.ts`, `ml/logging.ts` | Retention, deletion, local logs, graceful degradation |

## Cold start

The system never claims personalisation before it has the data.

```mermaid
flowchart LR
  A["Stage 1: no personal history"] -->|"enough labelled days for this activity"| B["Stage 2: early data"]
  A --> C["Uses target, today's check-in and tag statistics, shrunk to your overall rate"]
  B --> D["Uses the activity's own statistics"]
```

The Stage 1 → Stage 2 threshold is per user (`stage2_min_days`, default 10 labelled days) and
is configurable in `user_settings`. Confidence is a separate axis and also drops when
the check-in was skipped or in the reduced-confidence window after an off day.

## Two request flows

**Recording activity (learning starts immediately).**

```mermaid
sequenceDiagram
  participant U as User
  participant A as API
  participant L as ml/learning.ts
  participant D as SQLite
  U->>A: POST /api/activity/sessions
  A->>D: validate + insert session
  A->>L: recordActivityOutcomeSafe(task, day)
  L->>D: upsert activity_outcome_links (check-in state + observed outcome)
  L->>D: label any stored health prediction for that day
  A-->>U: session saved
```

Retraining does **not** happen on every write. A scheduled or explicit trigger asks the
retrain gate whether enough new labelled data has accumulated, and a rate limit prevents
churn.

**Getting today's plan.**

```mermaid
sequenceDiagram
  participant U as User
  participant A as API
  participant S as ml/serving.ts
  participant R as ml/registry.ts
  participant D as SQLite
  U->>A: GET /api/predictions/plan
  A->>D: read today's check-in (missing is one input, not a barrier)
  alt off day
    A-->>U: offDay: true, no predictions
  else normal day
    A->>S: serveTask per open personal task due on that date
    S->>R: load champion (if any)
    S->>D: log model vs baseline (health), never as an outcome
    A-->>U: plan + predictions + drift notes
  end
```

## Failure handling

Every learning step can fail for an ordinary reason (a missing check-in, an unreadable
model payload). None of those may stop you recording what you did:

- `ml/logging.ts` (`safeRun`) runs a step and returns a documented fallback if it throws, logging the error instead of propagating it.
- `ml/serving.ts` falls back to the baseline predictor when there is no champion, a payload cannot be read, a feature vector does not match, or the score is not a valid probability.
- `ml/health.ts` falls back to the baseline when the served model is worse than the baseline over the recent window.

## Related docs

- [data-model.md](data-model.md) — the tables
- [ml.md](ml.md) — features, algorithms, training, health, drift
- [predictions.md](predictions.md) — what is predicted and shown
- [operations.md](operations.md) — running, training and rollback
