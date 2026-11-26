# Machine learning

**Purpose.** How the completion model is built from your own recorded days, which algorithm is chosen and why, how it is versioned, promoted, watched and retrained, and what has actually been measured. Target probability and expected duration are baseline/statistical estimates, not trained models.

**Where in the code**

- `server/ml/features.ts` — the completion feature vector used by training and serving
- `server/ml/dataset.ts` — chronological training-set assembly
- `server/ml/training.ts` — completion candidate training, evaluation and the choice between candidates
- `server/ml/model/logistic.ts`, `gbm.ts`, `math.ts` — the completion algorithms
- `server/ml/calibration.ts` — probability calibration
- `server/ml/metrics.ts` — Brier, ECE and ROC-AUC for completion
- `server/ml/predictors.ts`, `server/ml/estimates.ts` — baseline completion, target probability and expected duration estimates
- `server/ml/pipeline.ts` — the completion training orchestration
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
The completion data flow is: **dataset → features → training → evaluation → registry → serving**,
with **learning → health → drift** running alongside. Target probability and expected duration are
baseline/statistical estimates throughout; they have no training pipeline or artifacts.

## Features

One module builds the completion vector for **both** training and serving, so a model can never be
fed something at serve time it did not see while training. Every feature uses only data available
**before** the prediction time. Target minutes and recorded durations feed the baseline estimates
and the scheduling context; they are not separate trained models.

Predictions are scoped to **personal tasks only**. `userTaskIds` excludes team tasks, so team
activity never enters a user's priors, tag/priority statistics, training set or drift checks, and
every prediction entry point rejects team tasks and another user's tasks. A check-in is an optional
input: its answers are served to the model when present and are simply missing otherwise — they
never gate a prediction.

| Group | Examples |
| --- | --- |
| History | completion rate, recent rate, recency-decayed rate, consistency, days since last completion, recent misses, weekday rate |
| Duration context | mean, median, recent trend — baseline statistics used for expected duration and scheduling |
| Target context | target achievement rate, target minutes, remaining target, today's progress — baseline statistics used for display and ranking |
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
| Smoothed baseline | completion (and the target/duration estimates) | Always available; the honest floor the completion model must beat and the source of the baseline numbers |
| Regularised logistic regression | completion | Few personal rows; strong L2 shrinkage toward the baseline is the honest choice. Deterministic (fixed steps, no randomness) |
| Histogram-based gradient-boosted trees | completion | The advanced challenger, tried only if it beats logistic. Deterministic feature subsampling, L2-shrunk leaves and a small hyperparameter grid (tree depth, leaf size, learning rate). XGBoost/CatBoost are skipped because the data volume does not justify a heavier toolchain |
| Isotonic / Platt calibration | the completion classifier | Fitted only when there is enough data; the calibration gate (below) decides whether a calibrated model is trusted |

The completion candidate is chosen **simplest-first**: the baseline is kept unless a model beats it
on chronological validation. Boosting searches three deterministic configurations on the same folds;
only the best boosted-tree setting may challenge logistic, and it must win by a margin.

## Training

- **Chronological only.** Rows are built day by day; a day's features use only earlier days. There is no shuffling and no random split.
- **One as-of rule for training and serving.** History stops the day before the date being predicted; the prior and tag/priority statistics use that same end date. Today's progress counts only what was already recorded at the prediction time: check-ins are reconstructed from their append-only history, and a session logged later is invisible (or clipped to the minutes that had elapsed). An edit made after a prediction cannot rewrite it.
- **A trained time grid.** Every labelled (task, day) produces rows at 08:00, 12:00, 16:00 and 20:00. Serving snaps the current local time to the most recent of those cutoffs, so a 09:00 view uses the 08:00 row and a 13:00 view uses the 12:00 row. A past date always uses 08:00.
- **Weighted toward recent days** with a half-life, so last month counts more than last spring.
- **Minimum rows** before a completion model is trained at all: 40 labelled rows, and at least 5 rows per feature. Early models use an 18-column compact set; the full vector is only used once there is enough evidence for every column. The chosen set and the time grid are stored in the artifact.
- **Validation** uses chronological folds whose boundaries fall on date edges, so all prediction-time rows for one day stay on the same side. The baseline, logistic regression and each boosted-tree configuration are scored on the same held-out days; the winning setting is recorded in the artifact's hyperparameters.
- **Calibration is scored honestly.** For each fold the calibrator is fitted only on out-of-fold rows from *earlier* folds, so reported Brier/ECE never reuse rows that fitted the curve. The last fold stays a genuine untouched window. Brier and ECE use the same sample weights.

## Calibration gate

A classifier may show a calibration error (ECE) no larger than **0.12** and still be trusted.
The calibrator is fitted only when there is enough data (60 rows for Platt, 200 for isotonic).
Calibration is always reported in evaluation output; the promotion gate also uses the honest
ECE above to decide whether a calibrated model is trusted.

## Registry: versions, promotion, rollback

- A trained completion model is stored as an **append-only** row with its full metadata (date range, counts, feature names, hyperparameters, seed, metrics, git commit) and its serialised payload. Older versions are never overwritten.
- Only one **completion champion** per user is ever served. Promoting a candidate retires the old champion; it does not delete it.
- A completion candidate is promoted only when it beats **both** the baseline and the current champion on chronological validation **and** passes the reliability (calibration) gate. Otherwise it is kept, or rejected, with the reason recorded.
- A champion is served only when its recorded feature names, in order, are exactly the columns the shared feature module builds today, and when its trained grid contains the snapped serving time. A reordered or renamed column cannot slip through a length check.
- `rollbackChampion` restores the previous version and keeps the newer one as `retired`.
- Fresh databases allow only `kind = 'completion'`. On older databases migration 21 deletes stale `target` and `duration` rows from the registry, shadow, retrain and health tables; completion rows are kept.

## Completion shadow protection

A completion candidate can be served **silently**: `ml_shadow` stores its prediction beside the
champion's on live days. The `label` stays `NULL` until the day is actually labelled, so a shadow
prediction is never mistaken for an outcome and is never shown to you. `promoteAfterShadow`
promotes only when the candidate also wins on the shadow window. This protects the served
completion number from a candidate that looked good on historical folds but loses on live days.

## Continuous learning

Recording activity is the moment the system learns something real.

- `recordActivityOutcome` writes one row per (task, day) in `activity_outcome_links`: the check-in state that preceded the day, the observed outcome, the tags and priority that applied. It is idempotent and reads the day through the same derivation the app shows, so it can never disagree.
- Per-tag statistics follow **immediately** from those links, without waiting for a retrain.
- Completion retraining is **gated**: it happens only when enough new labelled observations have accumulated (default 20) or the model is stale (default 30 days), and never more often than the rate limit (6 hours). The gate uses the promotion rules.
- A lightweight, unref'd scheduler asks the gate periodically (`ML_RETRAIN_EVERY_MS`, default 6 hours). It can be turned off with `ML_DISABLE_SCHEDULER=1`.

## What the user is actually served

Both prediction routes call `server/ml/live-predictor.ts`, which wraps `serving.ts`. That is
the link between the completion training above and the numbers in the app: the **completion
champion** is served when it is present and healthy, otherwise the baseline completion estimate
is served. Target probability and expected duration come from baseline/statistical estimates,
not from trained models. The current Nudge card displays the completion probability (percentage
beside the task, with a bar below); recommended time, target probability and expected duration
remain computed and logged but are not shown there. The completion number means
**"chance you'll work on it today"**: any logged activity counts, even a short session. It is not
a claim that the full time target was reached.
With no trained completion model yet, this is the baseline-only behaviour as before.
`ML_DISABLE_MODEL_SERVING=1` keeps that baseline-only path for comparison or emergencies
(read at startup). The wiring is covered by `server/ml/live-predictor.test.ts`.

## Baseline estimates (not models)

Target probability, expected duration and the recommended window are computed by the baseline
modules from your recorded task durations, completion history and timing profile. They remain
available for display, scheduling and plan ranking even before a model is trained, and they are
logged with predictions. They are **not** trained, versioned, promoted or health-checked;
only the completion probability has a champion.

## Completion health

A model that looked good on the historical window can still be wrong on your own days.
`health.ts` watches the completion model that is actually served, on your own logged predictions:

- Each served completion prediction is stored in `ml_health_predictions` beside the baseline's for the same day. The label is filled only from observed activity.
- Over a rolling window (28 days, minimum 12 labelled days), the champion and baseline are scored with **Brier and ECE**; calibration is checked against the same gate used in training.
- If the champion is worse than the baseline by a margin, or its calibration drifts past the gate, the system **falls back to the baseline completion estimate** and records why.
- **Fallback is sticky.** Once active it stays until a completion retrain clears it, so the champion is not flipped back on one good window. It is retried only after a rate-limited retrain.
- With too little data, nothing changes. The system says so instead of judging.

A plain-words health view (`GET /api/ml/health`) shows whether the completion champion is active,
when it last trained, the data counts and whether the baseline is being used. It is informational
and never nags. Target probability and expected duration are baseline estimates, so they have no
health verdict or fallback state.

## Drift

`drift.ts` does not try to predict change; it measures it from your own days and says so in
plain words:

- **Recent vs long-term** — the recent window (14 days, minimum 5 labelled days on each side) compared with the longer-term average, with a direction and a plain sentence.
- **Configuration changes** — a target, priority, tag set or name that changed is read from the versioned config history and dated, so a changed target is not mistaken for a change in you.
- **Explanations, not causes.** Everything is an association over your own days. Nothing claims why a rate moved.

Drift notes are additive: they are returned with the plan as informational text, never in
place of a prediction, and never change a number. The current Nudge card does not display them.

## Versioning and rollback

- Every completion model row is versioned and append-only; any version can be reloaded or restored.
- Rollback is one call (`rollbackChampion`) and keeps the newer version as retired.

See [operations.md](operations.md) for the commands.

## Evaluation on real data — not yet available

There is **no** accuracy figure for your own data. A fresh account has no history to train or
validate a personal completion model yet, so no accuracy number is claimed.
As you record activity, the completion health view will report real Brier/ECE numbers for the
served champion and the baseline. Expected duration and target probability are baseline
statistics, not measured model accuracy.

The `seed:ml` / `seed:ml:app` demo scripts print a **completion-only** synthetic backtest
(Brier, ECE and AUC against the baseline). They generate 365 days of history with a 60-day
holdout by default, so the advanced tree challenger has a much larger chronological check than
the earlier 150/30-day demo. `--days` and `--holdout` can override that for a smaller or larger run,
and `--through YYYY-MM-DD` extends the generated history into a future window for a forward check.
In that mode the model trains on earlier dates and is scored on synthetic future outcomes; those
outcomes are generated for the simulation, never observed facts. For full control use `--from`,
`--through`, `--train-from`, `--train-to`, `--test-from` and `--test-to`; the four window flags
must be supplied together and define exactly which generated days train the model and which are
held out. Those numbers describe generated history, never your own habits.

## Related docs

- [predictions.md](predictions.md) — what is served and shown
- [operations.md](operations.md) — training, retraining and rollback commands
- [decisions.md](decisions.md) — why these algorithms and gates
