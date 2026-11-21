# Privacy and limits

**Purpose.** What is stored, what stays on your machine, how to delete it, and the honest limits of the system.

**Where in the code**

- `server/ml/privacy.ts` — retention note, what is optional, deleting check-in history
- `server/ml/health-routes.ts` — the `/api/ml/privacy` endpoints
- `server/ml/logging.ts` — local-only logging
- `server/checkins-store.ts` — the optional check-in fields and their edit trail
- `server/db.ts` — the single local SQLite file

## Everything is local

- All learning runs in this app, on your machine. There is **no** external ML service, no telemetry and no upload path anywhere in the learning code.
- Every model, statistic and log line is derived from, and written back to, the local SQLite database (`server/data/todo.db`).
- File logging is opt-in (`ML_LOG_FILE`) and stays local.

## What is optional

- **Every check-in question is optional.** Missing stays missing; nothing is defaulted, inferred or filled in.
- The free-text context note and the mood / body / workload answers are the most personal, and are never required to use the app.
- Sensitive fields (kept as a named list in `server/ml/privacy.ts`): mood (`feeling`), stress, body, sleep and workload.
- Extra context questions are optional and off by default.

## Retention

The retention note is returned by `GET /api/ml/privacy` so it can be read in the app:

> Everything the learning system uses stays in this app's own local database on your machine.
> No personal data is sent to any external ML service. Check-ins are kept until you delete them;
> deleting them removes the check-ins and their edit trail, and clears the check-in state from
> the outcome links. Your recorded activity and the models trained from it are kept until you
> remove them.

## Deleting your check-in history

```bash
DELETE /api/ml/privacy/checkins
```

This removes every check-in and its edit trail, and resets the derived check-in state in the
outcome links to "not asked". It **never** deletes your recorded activity — what you actually
did is yours to keep. `GET /api/ml/privacy` returns counts only (no check-in content).

## Mood and energy are inputs, not a diagnosis

- Mood and energy are used only as **predictive inputs**.
- The system explains **associations**, never causes. It never says a rate moved *because* of a mood.
- Nothing here measures your worth, and nothing is a medical or diagnostic judgement.

## Predictions are never outcomes

- Predictions live in their own tables (`predictions`, `ml_shadow`, `ml_health_predictions`).
- Outcomes come only from your recorded activity (`activity_sessions`, `daily_activity_status`, `activity_outcome_links`).
- A stored prediction is **never** written back as an observed result. This is enforced in code and checked by the test suite.

## Preferred time is a hint only

A preferred time is optional and is only an initial hint. There are no rigid fixed/preferred/
flexible time categories, and a preferred time is never treated as a deadline.

## Known limits

- **No real accuracy figure yet.** The dataset is fresh. There is not enough history to train or validate a personal model, so no accuracy number is claimed.
- **Fresh dataset only.** No historical data was imported, and no training rows are fabricated.
- **Timing has no registered model.** The recommended window comes from a timing profile, not a trained model, so it is not versioned or gated like completion/target/duration. It is logged with the prediction but is not shown in the current UI.
- **Nudge is deliberately minimal.** It shows only the completion probability as a percentage beside the task name with a bar below; confidence, target probability and expected duration are still computed and logged, but are not displayed there.
- **The learning system needs data to personalise.** Stage 1 predictions are starting estimates; personalisation begins only once the stage-2 threshold is met.
- **Sensitive questions are optional**, so a prediction may run on less context than it could — this widens uncertainty rather than inventing a value.

## Related docs

- [data-model.md](data-model.md) — where each kind of data lives
- [checkin-and-energy.md](checkin-and-energy.md) — the optional check-in fields
- [ml.md](ml.md) — the models and why real accuracy is not claimed
- [operations.md](operations.md) — the privacy endpoints and logging controls
