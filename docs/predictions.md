# Predictions

**Purpose.** What the app predicts, which inputs feed each number, how the prediction is served and shown, and how the log keeps predictions apart from outcomes.

**Where in the code**

- `server/ml/predictors.ts` — the baseline prediction, the time window, the plan and its ranking
- `server/ml/serving.ts` — the champion model on top of the baseline
- `server/ml/live-predictor.ts` — the entry point the routes call (champion, or baseline fallback)
- `server/ml/cold-start.ts` — the two stages and confidence
- `server/ml/off-days.ts` — off days and the reduced-confidence window
- `server/ml/estimates.ts` — the display estimates and their validation
- `server/ml/predictions.ts` — the prediction log and feedback
- `server/ml/day-planner.ts` — the proposed flow and workload warning (still computed by the API, no longer shown in the UI)
- `server/ml/reschedule.ts` — display-only ideas for tasks that could move to another day (still computed by the API, no longer shown in the UI)
- `server/ml/prediction-routes.ts` — the `/api/predictions` routes
- `src/components/PredictionPanel.tsx` — the on-screen card

## What is predicted

| Number | Shown as | Meaning | Absent when |
| --- | --- | --- | --- |
| Completion probability | Nudge: "Chance of finishing today" subtitle, then task name + percentage with a bar below | How likely you are to finish the task that day | Never (always a number) |
| Ideal time | Nudge: "Ideal time: 10:30–11:00" below the bar | A suggested window from recorded start times for the task, or similar tasks when the task has none | No timing history exists |
| Target probability | Not shown in the current UI | How likely you are to reach the task's full time target | The task has no target duration |
| Expected duration | Not shown in the current UI | Roughly how long it usually takes | Not enough duration history |
| Confidence | Not shown in the current UI | How much personal history backs the number | Never |
| Stage | not shown | 1 (starting estimate) or 2 (personalised) | Never |

The recommended window is shown in Nudge as **Ideal time** when recorded timing history exists.
The proposed flow, workload warning, "better days" ideas, target probability and expected duration
are still computed, logged and returned by the API, but the current UI does not display them in
Nudge.

## What Nudge displays

The card is headed **Nudge** with the subtitle **Chance of finishing today** underneath and a
sparkle button that opens a hover/focus tooltip explaining the estimate. For each open personal
task due on the selected date it shows the task name, the completion probability as a percentage
beside it, and a bar underneath. When recorded start times exist it also shows **Ideal time**, a
suggested window based on that task's history or similar tasks, with a short source line. It does
not show a confidence label, target probability, estimated duration or progress wording.
Low-chance, low-priority tasks may also show **Worth a look** suggestions with *Drop it / Move it*
and *Keep it* actions. Nudge needs no check-in: today's tasks show a percentage straight away.
When a check-in *is* answered, those answers feed the predictor and Nudge refreshes with the
updated value; no answer simply means that input is missing. Only the off-day message still
appears when relevant. Nudge appears only on the My tasks board — Task Detail has no Nudge
section.

Everything is a **suggestion**. A preferred time, where one is set, is an initial hint
only — never a deadline.

## Inputs, per prediction

```mermaid
flowchart LR
  C["Today's check-in"] --> P["predictTask"]
  S["This activity's own history"] --> P
  T["Its tags' history"] --> P
  R["Its priority history"] --> P
  O["Off days + reduced-confidence window"] --> P
  F["Free-time budget from the check-in"] --> P
  TM["Timing profile (when do you actually do it)"] --> W["recommendWindow"]
  P --> W
```

- **Own history** — completion rate, recent rate, a recency-decayed rate, consistency, days since last completion, recent misses, weekday rate, target rate, duration mean/median/trend.
- **Tags** — the weighted completion rate and duration of the task's tags, shrunk toward your overall rate. Tag history is used, never invented.
- **Priority** — the priority that applied **on that day** (from the versioned config), shrunk toward your overall rate.
- **Check-in** — a small, bounded adjustment from the answered fields, plus the free-time budget.
- **Off days** — excluded from statistics; after an off period, confidence is reduced for a configurable number of days.
- **Today's progress** — minutes already recorded today, counted only up to the prediction time.

## Cold start and confidence

Two stages, with a per-user threshold (`stage2_min_days`, default 10 labelled days):

- **Stage 1** — no personal history for the activity. The prediction comes from the target, the day's check-in and the tag statistics, shrunk to your overall rate, and is labelled *insufficient personal history*. Confidence is never above low.
- **Stage 2** — the activity's own statistics drive the prediction.

Confidence drops when the check-in was skipped (wider uncertainty, never an invented value)
and in the reduced-confidence window after an off day. The Nudge card no longer prints a
sentence about the skip; the uncertainty is still part of the prediction.

## Baseline vs model

- The **baseline** (`predictors.ts`) always works and always has an answer. Its version string is `baseline-1.0.0`.
- A **champion model** (`serving.ts`) replaces the completion, target and duration numbers when one is registered, loadable and healthy. The recommended window and the explanation still come from the baseline, so timing is unchanged.
- If there is no champion, the payload cannot be read, the feature vector does not match, the score is invalid, or the live health check has fallen back, the baseline is served and the reason is stated.
- One entry point, `server/ml/live-predictor.ts`, is used by **both** `/api/predictions/plan` and `/api/predictions/task`, so the plan and the single-task view cannot disagree. With no champion in the database both show the baseline, exactly as before.
- `ML_DISABLE_MODEL_SERVING=1` keeps baseline-only behaviour on both routes without changing any model data (read at startup).

See [ml.md](ml.md) for how a champion is trained, promoted and watched.

## Plan and off days

- `GET /api/predictions/plan` always returns a plan for the requested date. An unanswered check-in is just one missing input; the response stays `gate: false` and shows numbers straight away.
- Predictions are **personal tasks only**. Team tasks are never predicted, never appear in Nudge, and never feed the history, statistics or training data behind a prediction. The single-task and statistics endpoints also refuse team tasks and other users' tasks.
- An off day returns `offDay: true` with **no** predictions at all.
- The plan only considers open **personal** tasks due on the requested date; team tasks and tasks due on other dates (or with no due date) are never part of it. It ranks them by probability, priority, what is left of the target and how much time is left. The ranking is a suggestion; it never changes a probability.
- The same `/plan` response also carries `schedule` (a proposed flow and workload warning) and `reschedules` (ideas for another day). Both are still computed as **display-only** data — nothing is written to a task's date — but the current UI does not show them. An off day suppresses both.
- Low-confidence, low-priority, sufficiently-labelled tasks may still produce **Worth a look** suggestions. They are offered as ideas, never forced.
- Plain-language **drift notes** (a recent-vs-long-term shift, or a dated configuration change) are returned with the plan. They are informational, never change a number, and are not displayed in the current Nudge card.

## The prediction log

The server — never the client — writes each prediction to the `predictions` table, separate
from outcomes. The log stores the source, model version, check-in state, the numbers, the
window, confidence, stage, an explanation and the raw inputs.

`prediction_feedback` records whether a suggestion was shown, whether it was exploratory and
whether you followed it — stored apart from both the predictions and the outcomes. A
prediction is **never** written back as an outcome.

## Related docs

- [checkin-and-energy.md](checkin-and-energy.md) — the check-in and how it feeds predictions
- [ml.md](ml.md) — training, promotion, health and drift
- [data-model.md](data-model.md) — the `predictions` and `prediction_feedback` tables
- [decisions.md](decisions.md) — why the preferred time is only a hint
