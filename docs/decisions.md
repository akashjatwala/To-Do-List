# Decisions

**Purpose.** The main design choices in the learning system and why each was made.

**Where in the code**

- `server/ml/` — every module named below
- `README.md` — the app overview

## Data and honesty

| Decision | Why |
| --- | --- |
| Fresh dataset only; no imported history | The user starts clean, so the system never pretends to know habits it has not seen |
| Never fabricate a training row | A made-up row would make the system look better than it is |
| Never claim accuracy without real evidence | The dataset is fresh, so no accuracy figure is claimed until there is real history to measure |
| Missing stays missing | A blank answer, an absent priority and a skipped day are real facts, and are stored as such, never defaulted |
| `not_asked` is different from `skipped` | "I did not open the app" and "I chose to skip" are different, and conflating them would corrupt the labels |
| A prediction is never an outcome | Predictions and outcomes live in separate tables; the label columns are filled only from observed activity |
| Remove unreferenced scaffold tables | Nine planning/target/weekly tables held no rows and had no references in `server/` or `src/`; keeping them made the data model look more complex than the app actually is |
| Keep `auth_tokens` session-only | Reset codes were removed entirely rather than exposed by an environment quirk; migration 12 deletes old rows and narrows the `kind` check. Password changes happen in My Account |

## Modelling

| Decision | Why |
| --- | --- |
| Chronological validation only; never shuffle | Personal data is a time series. A random split would leak the future and overstate accuracy |
| Smoothed baseline is the floor | It always works, and every model must beat it on held-out days to be served |
| Simplest model first | Logistic before gradient boosting; boosting must win by a margin. On small personal data, a simple model is the honest choice |
| Small, reproducible GBM instead of XGBoost/CatBoost | The data volume does not justify a heavy library; shallow trees with no randomness keep training reproducible |
| Linear quantile regression for duration | Duration needs a range, not just a point; a quantile model gives a low–high interval |
| Two-stage cold start with a configurable threshold | The system must not claim personalisation before it has the data |
| Calibration is gated (ECE ≤ 0.12) | A confident-but-miscalibrated model is worse than the baseline for a person |
| Recency weighting with a half-life | Recent behaviour matters more than last season, without discarding history |
| Seasonal features only after a year of data | A seasonal pattern cannot be learned from a few months |

## Serving, learning and safety

| Decision | Why |
| --- | --- |
| Baseline fallback whenever a champion cannot be trusted | The user is never shown a broken or out-of-range number |
| One live prediction entry point for both routes | The plan and the single-task view use the same champion/baseline decision, so they cannot disagree; `buildPlan` takes an injectable predictor and stays free of a dependency on serving |
| Reversible model serving via `ML_DISABLE_MODEL_SERVING=1` | Wiring trained models in is a behaviour change; a startup flag restores baseline-only predictions for comparison or an emergency without touching model data |
| Sticky health fallback | A model is not flipped back on one good window; it is retried only after a rate-limited retrain |
| Retraining is gated and rate-limited | Retraining on every write would churn; the gate waits for enough new labels or staleness |
| Lightweight, unref'd scheduler that can be disabled | Periodic learning should never keep the process alive or run without consent |
| Shadow mode before promotion | A candidate that wins on validation can still lose on live days; shadow mode catches that |
| Append-only model versions with rollback | Any version can be restored; nothing is overwritten |

## Product and privacy

| Decision | Why |
| --- | --- |
| Tags and priority are inputs, with versioned history | They change over time, so the value that applied on a given day is kept |
| Never invent a tag or priority value | A missing value is missing; guessing would bias the model |
| No fixed / preferred / flexible time categories | Preferred time is only an optional hint, never a deadline; timing is learned from when you actually do the thing |
| Mood is a predictive input, never a diagnosis | Associations are explained; causes are never claimed |
| Sensitive questions are optional | Personal context helps predictions but must never be required |
| Everything stays local | No external ML service, no telemetry, no upload path |
| Keep Nudge compact | The completion probability answers the card's question, with a percentage and bar; an ideal time is shown only when recorded timing history exists. Target, duration and confidence stay computed and logged but are not displayed |
| Drift is measured and reported, not predicted | A routine change is an association over your own days, returned by the API but not shown in the current Nudge card |
| Separate module per stage | Each stage (collection, validation, features, training, evaluation, prediction, learning, versioning) can be tested and replaced alone |

## Related docs

- [architecture.md](architecture.md) — how the modules fit together
- [ml.md](ml.md) — the algorithms and gates in detail
- [privacy-and-limits.md](privacy-and-limits.md) — the privacy rules and known limits
