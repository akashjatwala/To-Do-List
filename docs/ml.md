# Machine learning

**Purpose.** How the models are built from your own recorded days, which algorithm is chosen and why, how they are versioned, promoted, watched and retrained, and what has actually been measured.

**Where in the code**

- `server/ml/features.ts` — the one feature vector used by training and serving
- `server/ml/dataset.ts` — chronological training-set assembly
- `server/ml/training.ts` — candidate training, evaluation and the choice between candidates
- `server/ml/model/logistic.ts`, `gbm.ts`, `quantile.ts`, `math.ts` — the algorithms
- `server/ml/calibration.ts` — probability calibration
- `server/ml/metrics.ts` — Brier, calibration error, MAE/RMSE, ROC-AUC, coverage
- `server/ml/pipeline.ts` — the training orchestration
- `server/ml/registry.ts` — versions, promotion, rollback, loading
- `server/ml/shadow.ts` — shadow mode
- `server/ml/serving.ts` — serving the champion with a safe fallback
- `server/ml/live-predictor.ts` — the entry point the HTTP routes actually call
- `server/ml/learning.ts` — the retrain gate, rate limit and scheduler
- `server/ml/health.ts` — live model health and automatic fallback
- `server/ml/drift.ts` — recent-vs-long-term drift and dated config changes

> **Schema note (2026-11-18).** The cleanup that removed unused planning/target/weekly scaffold
> tables did not touch any ML table or model module. `ml_models`, `ml_shadow`,
> `ml_health_predictions`, `ml_health`, `ml_retrain_state`, `ml_retrain_log` and
> `activity_outcome_links` are unchanged. `prediction_settings` was merged into `user_settings`;
> `getPredictionSettings` and `savePredictionSettings` now read and write that table, with the
> same defaults and column names for the prediction fields.

## Modules

Each stage is a separate module with a single job, so it can be tested and replaced alone.
The data flow is: **dataset → features → training → evaluation → registry → serving**, with
**learning → health → drift** running alongside.

## Features

One module builds the vector for **both** training and serving, so a model can never be fed
something at serve time it did not see while training. Every feature uses only data available
**before** the prediction time.

Predictions are scoped to **personal tasks only**. `userTaskIds` excludes team tasks, so team
activity never enters a user's priors, tag/priority statistics, training set or drift checks, and
every prediction entry point rejects team tasks and another user's tasks. A check-in is an optional
input: its answers are served to the model when present and are simply missing otherwise — they
never gate a prediction.

| Group | Examples |
| --- | --- |
| History | completion rate, recent rate, recency-decayed rate, consistency, days since last completion, recent misses, weekday rate |
| Duration | mean, median, recent trend |
| Target | target achievement rate, target minutes, remaining target, today's progress |
| Tags | multi-hot tag membership against a fixed vocabulary, tag completion rate, tag duration median |
| Priority | ordinal level for the day, taken from the versioned config |
| Check-in | a zero-centred "goodness" per field plus an explicit missing indicator per field |
| Timing | peak time bin, concentration |
| Exposure | recommendations shown / exploratory / followed over recent days |
| Seasonal | sine/cosine of day-of-year, **only** once at least a year of data exists |

A missing value is encoded as **explicit missing** (an indicator column plus a neutral value),
never as a normal answer. Tags with too few observations collapse into `tag_other`; a task with
no tags is flagged `tag_missing`.

## Algorithms, and why

| Candidate | Used for | Why this one |
| --- | --- | --- |
| Smoothed baseline | completion, target, duration | Always available; the honest floor every model must beat |
| Regularised logistic regression | completion, target | Few personal rows; strong L2 shrinkage toward the baseline is the honest choice. Deterministic (fixed steps, no randomness) |
| Small gradient-boosted trees | completion, target | The brief's "only if it beats logistic". Deliberately shallow, no subsampling, reproducible. XGBoost/CatBoost are skipped because the data volume does not justify them |
| Linear quantile regression | duration | Gives a point estimate **and** a low–high interval; median baseline as the floor |
| Isotonic / Platt calibration | all classifiers | Fitted only when there is enough data; the calibration gate (below) decides whether a calibrated model is trusted |

A candidate is chosen **simplest-first**: the baseline is kept unless a model beats it on
chronological validation (and gradient boosting must beat logistic by a margin to be chosen).

## Training

- **Chronological only.** Rows are built day by day; a day's features use only earlier days. There is no shuffling and no random split.
- **Weighted toward recent days** with a half-life, so last month counts more than last spring.
- **Minimum rows** before a model is trained at all: completion 40, target 40, duration 20. Below that the baseline is served and labelled as a starting estimate.
- **Validation** uses chronological folds; the baseline and the current champion are scored on the same held-out days.

## Calibration gate

A classifier may show a calibration error (ECE) no larger than **0.12** and still be trusted.
The calibrator is fitted only when there is enough data (60 rows for Platt, 200 for isotonic).
Calibration is **reported, never gated** in evaluation — it is used to decide whether a
calibrated model is served.

## Registry: versions, promotion, rollback

- A trained model is stored as an **append-only** row with its full metadata (date range, counts, feature names, hyperparameters, seed, metrics, git commit) and its serialised payload. Older versions are never overwritten.
- Only one **champion** per (user, kind) is ever served. Promoting a candidate retires the old champion; it does not delete it.
- A candidate is promoted only when it beats **both** the baseline and the current champion on chronological validation **and** passes the reliability (calibration) gate. Otherwise it is kept, or rejected, with the reason recorded.
- `rollbackChampion` restores the previous version and keeps the newer one as `retired`.

## Shadow mode

A candidate can be served **silently**: `ml_shadow` stores its prediction beside the champion's
on live days. The `label` stays `NULL` until the day is actually labelled, so a shadow
prediction is never mistaken for an outcome and is never shown to you. `promoteAfterShadow`
promotes only when the candidate also wins on the shadow window.

## Continuous learning

Recording activity is the moment the system learns something real.

- `recordActivityOutcome` writes one row per (task, day) in `activity_outcome_links`: the check-in state that preceded the day, the observed outcome, the tags and priority that applied. It is idempotent and reads the day through the same derivation the app shows, so it can never disagree.
- Per-tag statistics follow **immediately** from those links, without waiting for a retrain.
- Retraining is **gated**: it happens only when enough new labelled observations have accumulated (default 20) or a model is stale (default 30 days), and never more often than the rate limit (6 hours). The gate uses the promotion rules.
- A lightweight, unref'd scheduler asks the gate periodically (`ML_RETRAIN_EVERY_MS`, default 6 hours). It can be turned off with `ML_DISABLE_SCHEDULER=1`.

## What the user is actually served

Both prediction routes call `server/ml/live-predictor.ts`, which wraps `serving.ts`. That is
the link between all the training above and the numbers in the app: the champion is served
for completion, target and duration when present and healthy, otherwise the baseline is
served. The current Nudge card displays only the completion probability (percentage beside
the task, with a bar below); target and duration remain computed and logged but are not shown
there. With no trained model yet, this is the baseline-only behaviour as before.
`ML_DISABLE_MODEL_SERVING=1` keeps that baseline-only path for comparison or emergencies
(read at startup). The wiring is covered by `server/ml/live-predictor.test.ts`.

## Live model health

A model that looked good on the historical window can still be wrong on your own days.
`health.ts` watches the model that is actually served, on your own logged predictions:

- Each served prediction is stored in `ml_health_predictions` beside the baseline's for the same day. The label is filled only from observed activity.
- Over a rolling window (28 days, minimum 12 labelled days), the model and baseline are scored (Brier for classifiers, MAE for duration) and the calibration error is checked.
- If the model is worse than the baseline by a margin, or its calibration drifts past the gate, the system **falls back to the baseline** for that kind and records why.
- **Fallback is sticky.** Once active it stays until a retrain clears it, so a model is not flipped back on one good window. It is retried only after a rate-limited retrain.
- With too little data, nothing changes. The system says so instead of judging.

A plain-words health view (`GET /api/ml/health`) shows which models are active, when they last
trained, the data counts and whether the baseline is being used. It is informational and never
nags.

## Drift

`drift.ts` does not try to predict change; it measures it from your own days and says so in
plain words:

- **Recent vs long-term** — the recent window (14 days, minimum 5 labelled days on each side) compared with the longer-term average, with a direction and a plain sentence.
- **Configuration changes** — a target, priority, tag set or preferred time that changed is read from the versioned config history and dated, so a changed target is not mistaken for a change in you.
- **Explanations, not causes.** Everything is an association over your own days. Nothing claims why a rate moved.

Drift notes are additive: they are returned with the plan as informational text, never in
place of a prediction, and never change a number. The current Nudge card does not display them.

## Versioning and rollback

- Every model row is versioned and append-only; any version can be reloaded or restored.
- Rollback is one call (`rollbackChampion`) and keeps the newer version as retired.

See [operations.md](operations.md) for the commands.

## Evaluation on real data — not yet available

There is **no** accuracy figure for your own data. The dataset is fresh, so there is not enough
history to train or validate a personal model yet. No accuracy number is invented, and none is
claimed. As you record activity, the health view will report real numbers, per task and per tag,
never as one blended score.

## Related docs

- [predictions.md](predictions.md) — what is served and shown
- [operations.md](operations.md) — training, retraining and rollback commands
- [decisions.md](decisions.md) — why these algorithms and gates
