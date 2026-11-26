# Privacy and limits

**Purpose.** What is stored, what stays on your machine, and the honest limits of the system.

**Where in the code**

- `server/ml/logging.ts` — local-only logging
- `server/checkins-store.ts` — the optional check-in fields and their edit trail
- `server/db.ts` — the single local SQLite file

## Everything is local

- All learning runs in this app, on your machine. There is **no** external ML service, no telemetry and no upload path anywhere in the learning code.
- Every model, statistic and log line is derived from, and written back to, the local SQLite database (`server/data/todo.db`).
- File logging is opt-in (`ML_LOG_FILE`) and stays local.
- Reminders are local records in the same database; sending one never delivers an email, push notification or webhook.
- The notification centre is a local view of invitations, reminders, comments, assignments and task moves. Its read marker is stored in your browser only; it does not create a delivery queue or external message.

## What is optional

- **Every check-in question is optional.** Missing stays missing; answers are stored as given.
- The free-text context note and the mood / body / workload answers are the most personal, and are never required to use the app.
- The most personal answers are mood (`feeling`), stress, body, sleep and workload.
- Extra context questions are optional and off by default.

## Retention

Check-ins, their edit trail and everything the learning system derives from them stay in the app's own local database. Nothing is uploaded. There is no in-app privacy panel, check-in deletion workflow, or deletion API; check-ins are edited in place.

## Mood and energy are inputs, not a diagnosis

- Mood and energy are used only as **predictive inputs**.
- The system explains **associations**, never causes. It never says a rate moved *because* of a mood.
- Nothing here measures your worth, and nothing is a medical or diagnostic judgement.

## Predictions are never outcomes

- Predictions live in their own tables (`predictions`, `ml_shadow`, `ml_health_predictions`).
- Predictions are for your personal tasks only. Team tasks are never predicted and never feed the completion model's training data or statistics.
- Check-in answers are an optional prediction input: Nudge shows a value without them and refreshes when they are answered.
- Outcomes come only from your recorded activity (`activity_sessions`, `daily_activity_status`, `activity_outcome_links`).
- A stored prediction is **never** written back as an observed result. This is enforced in code and checked by the test suite.

## Time entries are yours, and visible to teammates on shared tasks

- Task Detail's **Task time** card stores each start/completion pair as your own activity session.
- On a personal task only you can see your entries.
- On a team task every member can see everyone's entries and who logged them, but only the author can delete an entry. Overlap checks are per author, so teammates can work the same stretch independently.

## Known limits

- **No real accuracy figure yet.** A fresh account has no history to train or validate a personal completion model, so no accuracy number is claimed for your own habits. The demo backtest uses generated data only.
- **Fresh dataset only.** No historical data was imported into your account. Completion training uses only the activity you record here.
- **Only completion is a trained model.** Target probability and expected duration are baseline/statistical estimates from your recorded durations and history; they are not trained, versioned or gated like the completion champion.
- **The recommended window has no registered model.** It comes from a timing profile, not a trained model, so it is not versioned or gated like the completion champion. It is logged with the prediction but is not shown in Nudge.
- **Nudge is deliberately compact.** It shows the completion probability as a percentage beside the task name with a bar below; confidence, baseline target probability, expected duration and recommended time are still computed and logged, but are not displayed there.
- **The learning system needs data to personalise.** Stage 1 predictions are starting estimates; personalisation begins only once the stage-2 threshold is met.
- **Sensitive questions are optional**, so a prediction may run on less context than it could — which widens uncertainty.

## Related docs

- [data-model.md](data-model.md) — where each kind of data lives
- [checkin-and-energy.md](checkin-and-energy.md) — the optional check-in fields
- [ml.md](ml.md) — the completion model and why real accuracy is not claimed
