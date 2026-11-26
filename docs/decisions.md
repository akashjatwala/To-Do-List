# Decisions

**Purpose.** The main design choices in the learning system and why each was made.

**Where in the code**

- `server/ml/` — every module named below
- `README.md` — the app overview

## Data and honesty

| Decision | Why |
| --- | --- |
| Fresh dataset only; no imported history | The user starts clean, so the system learns only from habits it has observed here |
| Training rows come only from recorded activity | A user's history is built from what they actually do |
| Never claim accuracy without real evidence | An accuracy figure for a person's own habits is only claimed after their own history is measured |
| Missing stays missing | A blank answer, an absent priority and a skipped day are real facts, and are stored as given |
| `not_asked` is different from `skipped` | "I did not open the app" and "I chose to skip" are different, and conflating them would corrupt the labels |
| A prediction is never an outcome | Predictions and outcomes live in separate tables; the label columns are filled only from observed activity |
| Remove unreferenced scaffold tables | Nine planning/target/weekly tables held no rows and had no references in `server/` or `src/`; keeping them made the data model look more complex than the app actually is |
| Keep `auth_tokens` session-only | Reset codes were removed entirely rather than exposed by an environment quirk; migration 12 deletes old rows and narrows the `kind` check. Password changes happen in My Account |
| Reminders are records, not delivery | An in-app reminder is stored locally and shown in the Overdue card; no email, push or webhook is introduced |

## Modelling

| Decision | Why |
| --- | --- |
| Chronological validation only; never shuffle | Personal data is a time series. A random split would leak the future and overstate accuracy |
| Smoothed baseline is the floor | It always works, and the completion model must beat it on held-out days to be served |
| Simplest model first | Logistic before gradient boosting for completion; boosting must win by a margin. On small personal data, a simple model is the honest choice |
| Histogram-based GBM with a tiny fixed grid instead of XGBoost/CatBoost | The data volume does not justify a heavy library; deterministic feature subsampling, L2-shrunk leaves and three searched configurations add real non-linearity without randomness or a new toolchain |
| Only completion is trained | Target probability and expected duration stay baseline/statistical estimates for display, scheduling and ranking; one champion keeps gates, health and artifacts honest |
| Migration 21 drops stale target/duration model rows | Upgraded databases may still have old champions and health rows for kinds that are no longer trained; deleting only those rows keeps the registry and health view completion-only without rebuilding tables |
| Migration 22 removes preferred-time columns | The field is no longer stored, accepted or used; dropping both legacy columns avoids carrying dead state |
| Two-stage cold start with a configurable threshold | The system must not claim personalisation before it has the data |
| Calibration is gated (ECE ≤ 0.12) | A confident-but-miscalibrated completion model is worse than the baseline for a person |
| Recency weighting with a half-life | Recent behaviour matters more than last season, without discarding history |
| Seasonal features only after a year of data | A seasonal pattern cannot be learned from a few months |

## Serving, learning and safety

| Decision | Why |
| --- | --- |
| Baseline fallback whenever the completion champion cannot be trusted | The user is never shown a broken or out-of-range completion number; target probability and expected duration are baseline estimates either way |
| One live prediction entry point for both routes | The plan and the single-task view use the same completion champion/baseline decision, so they cannot disagree; `buildPlan` takes an injectable predictor and stays free of a dependency on serving |
| Reversible model serving via `ML_DISABLE_MODEL_SERVING=1` | Wiring the trained completion model in is a behaviour change; a startup flag restores baseline-only estimates for comparison or an emergency without touching model data |
| Sticky completion health fallback | The champion is not flipped back on one good window; it is retried only after a rate-limited completion retrain |
| Completion retraining is gated and rate-limited | Retraining on every write would churn; the gate waits for enough new labels or staleness |
| Lightweight, unref'd scheduler that can be disabled | Periodic learning should never keep the process alive or run without consent |
| Shadow protection before promotion | A completion candidate that wins on validation can still lose on live days; shadow mode catches that |
| Append-only completion model versions with rollback | Any version can be restored; nothing is overwritten |

## Product and privacy

| Decision | Why |
| --- | --- |
| Tags and priority are inputs, with versioned history | They change over time, so the value that applied on a given day is kept |
| Missing tag and priority values stay missing | Keeping an absent value absent avoids biasing the model |
| No fixed / flexible time categories | Time-of-day suggestions come only from recorded activity, never a deadline or a stored preference |
| Mood is a predictive input, never a diagnosis | Associations are explained; causes are never claimed |
| Sensitive questions are optional | Personal context helps predictions but must never be required |
| Everything stays local | No external ML service, no telemetry, no upload path |
| User-set target durations stay first-class | The task's `duration` / target duration is user-facing; baseline target probability and expected duration use it for display and scheduling, with no trained duration model |
| Keep Nudge compact | The completion probability answers the card's question, with a percentage and bar. Baseline target probability, expected duration, recommended time and confidence stay computed and logged but are not displayed |
| Drift is measured and reported, not predicted | A routine change is an association over your own days, returned by the API but not shown in the current Nudge card |
| Separate module per stage | Each stage (collection, validation, features, training, evaluation, prediction, learning, versioning) can be tested and replaced alone |

## Related docs

- [architecture.md](architecture.md) — how the modules fit together
- [ml.md](ml.md) — the algorithms and gates in detail
- [privacy-and-limits.md](privacy-and-limits.md) — local data rules and known limits
