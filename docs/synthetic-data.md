# Synthetic data

**Purpose.** A generated one-year dataset and an evaluation harness that exercise the whole learning pipeline before any real personal data exists — isolated from the app and never an accuracy claim.

**Where in the code**

- `server/ml/synthetic/cli.ts` — the `generate` / `reload` / `report` / `train` / `asof` / `purge` commands
- `server/ml/synthetic/generate.ts`, `model.ts`, `person.ts`, `hidden-state.ts`, `outcomes.ts` — the generator
- `server/ml/synthetic/isolation.ts`, `reload.ts`, `purge.ts` — the isolated sandbox database
- `server/ml/synthetic/export-csv.ts`, `writer.ts`, `asof.ts`, `coverage.ts`, `csv.ts` — files, as-of rebuilds, coverage
- `server/ml/synthetic/harness.ts`, `checks.ts`, `phase5-checks.ts`, `phase6-checks.ts` — the evaluation harness
- `server/ml/synthetic/README.md` — the generator's own detailed notes

## What it is

One synthetic person, one year of daily records, written as CSV with the app's own column
names, plus hidden ground truth. It exists so the validation, feature-engineering, training and
evaluation code can run end to end on data whose hidden rules are known.

> This data is generated. It is **never** real, it is **never** mixed into the app's database
> or predictions, and **no accuracy figure may ever be reported from it** as if it were your own.

## Hard rules, enforced in code

- **Isolation** — everything lives under `synthetic-data/` in its own database (`synthetic-data/synthetic.db`). Nothing here imports the app's real database.
- **Flagged** — every person is a separate user with a reserved email domain, and every row carries `person_id` and `synthetic = 1`.
- **Never promotable** — a model registered from synthetic data is stored with `synthetic = 1`; the promotion gate always refuses it in the real app.
- **Never an outcome** — a stored prediction is never written back as an observed result.
- **Reproducible** — all randomness comes from one seed; the same seed produces byte-identical files (verified by `checksums.csv`).
- **Never fabricated accuracy** — the harness reports only the checks that can honestly run.

## Commands

Run from the repo root. npm scripts wrap the same commands.

| Command | What it does |
| --- | --- |
| `node --import tsx server/ml/synthetic/cli.ts generate` | Generate the full year (7 tasks). Add `--quick` for ~3 months, 4 tasks |
| `node --import tsx server/ml/synthetic/cli.ts reload` | Load the core observed CSVs into the isolated database |
| `node --import tsx server/ml/synthetic/cli.ts report` | Run the evaluation harness across three seeds |
| `node --import tsx server/ml/synthetic/cli.ts train` | Train models in the sandbox (`--promote --fresh --seed N --folds N --commit SHA`) |
| `node --import tsx server/ml/synthetic/cli.ts asof --date YYYY-MM-DD` | Rebuild the dataset as it stood on a cutoff (no future leakage) |
| `node --import tsx server/ml/synthetic/cli.ts purge` | Delete the generated dataset |

npm equivalents: `synthetic:generate`, `synthetic:reload`, `synthetic:report`, `synthetic:train`, `synthetic:asof`, `synthetic:purge`.

`generate` prints the estimated row count first, shrinks the task count if the estimate would
breach the cap, and refuses to start if even the minimum cannot fit. Only the manifest, the
coverage report and row counts are ever printed — the generated data itself is not shown.

## Output layout

```
synthetic-data/
  person-001/
    tasks.csv  tags.csv  tag_history.csv  task_tags.csv  task_configs.csv
    activity_sessions.csv  daily_activity_status.csv
    checkins.csv  checkin_history.csv  day_reviews.csv
    context_questions.csv  session_context.csv  state_suggestion_choices.csv
    layer_off_days.csv  layer_recommendations.csv
    layer_regime_change.csv  layer_live_replay.csv
    manifest.csv  quality_report.csv
    as-of-YYYY-MM-DD/…            # one folder per `asof` run
  ground-truth/
    params.csv  daily_probability.csv  hidden_state.csv
    off_days.csv  recommendations.csv
  checksums.csv                   # SHA-256 per file
  synthetic.db                    # isolated reload target (regenerable)
```

## What the dataset contains

One person mixes many behaviours: a seasonal shift, a burnout dip, a deadline cycle, a
near-random task, a habit-builder task, one task whose outcome is pure noise, one priority
level that is pure noise, mood affecting some tasks (e.g. exercise) and not others (e.g.
reading), a **regime change** after the validation period, travel and sick weeks, a schedule
change, a sparse-logging period, and off days of every kind.

Per day it records a hidden state with carry-over, weekday and seasonal effects, 1–3 sessions
per task (duration varying, shrinking on low energy, split across sittings), start times that
shift with season, gradual drift and noise. Around 10–15% of check-ins are skipped, some
answers are partial, some check-ins are edited mid-day, and end-of-day reviews are recorded.
Deliberately messy entries are produced and rejected through the app's own validation
functions.

## The evaluation harness

`report` runs, across at least three seeds, the checks that can honestly run, per task and per
tag, never as one blended score:

- **Data quality and leakage** — coverage matrix, no future leakage, pending days carry no labels.
- **Phase 2a** — does the readiness score relate to what got done, per task; do the display estimates beat the simple baselines.
- **Phase 4** — probabilities in range, ordered intervals, off days suppress predictions, exploration is rare, predictions logged without writing outcomes.
- **Phase 5** — chronological holdout, model vs baseline Brier, calibration, duration error and coverage, learning curve, feature ablations, the mood-zero-effect control, the regime-change error change, promotion/rollback, and the "synthetic is never promotable" check.
- **Phase 6** — rolling retraining (continuous-learning simulation), drift from the user's own days, the regime-change error change, promotion/rollback, the retrain trigger and its rate limit, and the live-health fallback (small-data guard, trigger, recovery).

The full report from the current run, with all numbers labelled synthetic, is summarised in
[ml.md](ml.md).

## Defaults

| Setting | Value |
| --- | --- |
| Window | 365 days |
| Tasks | 7 |
| End date | 2026-11-17 |
| Seed | 20261117 |
| Reported seeds | 20261117, 20261118, 20261119 |
| Row count | ~6,590 per seed (cap 10,000) |

## Related docs

- [ml.md](ml.md) — the models the harness exercises
- [operations.md](operations.md) — how to run the commands
- [decisions.md](decisions.md) — why synthetic data was used before real data
