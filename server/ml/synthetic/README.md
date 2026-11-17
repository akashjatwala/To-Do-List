# Synthetic dataset (Phase 3)

A single-person, one-year **synthetic** dataset, written as CSV, for exercising the
learning pipeline before any real personal data exists. It is a correctness and
sanity check: it lets the validation, feature-engineering, training and evaluation
code run end to end on data whose hidden rules are known.

> This data is generated. It is **never** real, it is **never** mixed into the
> app's database or predictions, and **no accuracy figure may ever be reported
> from it** as if it were the user's own.

## Hard rules, enforced in code

- **Isolation.** Everything lives under `synthetic-data/` at the repo root, in its
  own database file (`synthetic-data/synthetic.db`). Nothing here imports the
  app's real `db` singleton or writes to `server/data/todo.db`.
- **Flagged.** Every person is a separate user with a reserved email domain
  (`…@synthetic.local`), and every row carries `person_id` and a `synthetic = 1`
  flag.
- **Never promotable.** A model registered from synthetic data is stored with
  `synthetic = 1`; `canPromoteModel` always refuses it and there is no code path
  that promotes one.
- **Never an outcome.** A stored prediction is never written back as an observed
  result (checked explicitly).
- **Reproducible.** All randomness comes from one seed (`rng.ts`; no `Math.random`).
  The generator assigns every id and timestamp itself, so the same seed produces
  byte-identical files, verified by `checksums.csv`.
- **Never fabricated accuracy.** The evaluation harness reports only the checks
  that can honestly run today; every Phase 5 metric is a stub that throws rather
  than printing a made-up number.

## Commands

Run these from the repo root (npm scripts wrap the same commands):

```
node --import tsx server/ml/synthetic/cli.ts generate            # full year, 7 tasks
node --import tsx server/ml/synthetic/cli.ts generate --quick    # ~3 months, 4 tasks
node --import tsx server/ml/synthetic/cli.ts generate --seed 7 --end 2026-06-30 --days 180
node --import tsx server/ml/synthetic/cli.ts asof --date 2026-06-01
node --import tsx server/ml/synthetic/cli.ts reload
node --import tsx server/ml/synthetic/cli.ts report
node --import tsx server/ml/synthetic/cli.ts purge
```

npm equivalents: `npm run synthetic:generate` (add `-- --quick` for quick mode),
`synthetic:asof`, `synthetic:reload`, `synthetic:report`, `synthetic:purge`.

`generate` prints the estimated row count first, shrinks the task count if the
estimate would breach the cap, and refuses to start if even the minimum cannot
fit. Only the manifest, the coverage report and row counts are ever printed — the
generated data itself is not shown.

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

Every observed CSV uses the app's own `snake_case` column names, `person_id`
first and `synthetic` last, ISO 8601 (UTC) timestamps, UTF-8 and LF endings.
Ground truth is written only to `ground-truth/` and is read only by the harness.

## Sizing

| preset  | window | tasks | rows (observed + ground truth) |
| ------- | ------ | ----- | ------------------------------ |
| default | 365 d  | 7     | 5000–8000 (cap 10,000)         |
| `--quick` | 90 d | 4     | 1200–1500                      |

`countRows` counts **every** row written, ground truth included, so the cap
applies to the whole dataset. `estimateRows`/`planGeneration` run before anything
is generated.

## What the dataset contains

One person mixes all 23 catalogue behaviours, some as per-task behaviours and
some as scripted episodes: a seasonal shift, a burnout dip, a deadline cycle, a
near-random task, a habit-builder task, one task whose outcome is pure noise and
one priority level that is pure noise, mood affecting some tasks (e.g. exercise)
and not others (e.g. reading), a regime change after the validation period with a
calm stretch before it, travel and sick weeks, a schedule change, a sparse-logging
period, and off days of every kind (a range, a single day, one with no reason, one
added after the fact).

Per day it records a hidden state with carry-over, weekday and seasonal effects,
1–3 activity sessions per task (duration varying, shrinking on low energy, split
across multiple sittings), start times that shift with season and circumstances,
gradual drift and noise. Around 10–15% of check-ins are skipped, some answers are
partial, some check-ins are edited mid-day, and end-of-day reviews are recorded.
Deliberately messy entries are produced and rejected through the app's own
validation functions.

The most recent `pendingTailDays` are left pending. A pending day carries no
label and no session — it reads as "pending", never as "skipped" — and an `asof`
rebuild reproduces the dataset exactly as it stood at a cutoff, with no future
leakage.

## Coverage matrix

The run fails unless every counted condition meets its minimum and the cap is
respected. Counted conditions: skipped check-ins, partial check-ins, mid-day
edits, end-of-day reviews, multi-session days, target/priority/tag changes, tasks
created mid-way, tasks retired, postponed-with-reason, skipped-with-reason,
late-logged completions, invalid/duplicate entries rejected, off-day periods,
recommendations (shown, exploratory, followed, ignored, nudged, reschedule and
drop accepted/ignored), items left open mid-period and pending latest days — plus
the condition flags listed above. Quick mode uses scaled-down minimums.

## Evaluation harness

`report` runs the checks that exist today across at least three seeds and shows
the weakest next to the best: the data-quality and leakage checks, and the Phase
2a checks (does the readiness score relate to what got done, per task; do the
display estimates beat the simple baselines). It reports **per task and per tag,
never as one blended score**. The Phase 5 metrics — Brier score, calibration,
learning curve, ablation, drift, promotion/rollback, mood-zero-effect control —
are present as labelled stubs that throw rather than invent a number.

## Layers

Each optional layer is its own file with its own switch and seed, flagged
synthetic: off days, recommendation exposure (including exploratory picks and
reschedule/drop suggestions with follow/ignore/nudge responses), regime change,
and live replay (days fed one at a time; the prediction column is filled by the
system in a later phase, never by the generator).

## Known limitations

- The isolated reload loads only the **core observed** CSVs. Layer files and
  ground truth stay file-only: the app has no tables for the synthetic-only
  layers, so they are not round-tripped into `synthetic.db`.
- The Phase 5 metrics are stubs; nothing here produces or claims accuracy.
- Random extra people are off by default; there is a held-out-person hook but the
  shipped dataset is the single named person.
- Ground truth is excluded from the observed files by construction and lives only
  in `ground-truth/`; keep it that way when extending the generator.
