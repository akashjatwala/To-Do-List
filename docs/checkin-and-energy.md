# Check-in and energy

**Purpose.** The daily check-in, its nine questions, how it is stored and shown, and how the energy/readiness view is derived from it.

**Where in the code**

- `server/checkins-store.ts` — the questions, validation, storage and edit trail
- `server/checkins.ts` — the `/api/checkins` routes
- `server/ml/readiness.ts` — the readiness score and sub-scores
- `server/ml/recent-context.ts`, `server/ml/similar-days.ts` — recent-change and similar-day context
- `src/lib/checkin.ts` — the question labels and options (shared with the API)
- `src/lib/energy.ts` — the display-only energy card helpers
- `src/components/CheckinModal.tsx`, `DailyStateCard.tsx`, `EnergyDetailSheet.tsx` — the UI

## The nine questions

Every question is optional. Answers are stored as an ordinal **1–5**, where 1 is the
first option shown and 5 the last. For every question 1 is the "best" end and 5 the
"worst"; the display flips this so that higher always means better.

| Key | Field | Key | Field |
| --- | --- | --- | --- |
| `feeling` | Mood | `free_time` | Free time |
| `energy` | Energy | `focus` | Focus |
| `motivation` | Motivation | `body` | Body |
| `sleep` | Sleep | `workload` | Workload |
| `stress` | Stress | | |

## How it is stored

- One row per user per day in `checkins`. A blank answer is `NULL`.
- Skipping the whole check-in writes a row with `skipped = 1` and **no** answers — never neutral values.
- A day you never touched has **no row at all**. That is different from skipping.
- Every write appends a snapshot to `checkin_history`, so a mid-day change keeps its timestamp.
- The free-text `context` note (max 500 characters) is optional and is the most personal field.

The four states a day can be in are derived, not stored: `not_asked` (no row),
`completed` (all nine answered), `partial` (some answered) and `skipped`.

## Readiness score

`server/ml/readiness.ts` turns the answers into a 0–100 score.

- The score needs at least **3** answered fields to be shown, and is marked **partial** below **5**.
- Three internal sub-scores, each from a fixed group of answered fields:
  - **physical** — energy, sleep, body
  - **mental** — feeling, focus, motivation
  - **capacity** — free time, workload, stress
- A sub-score needs at least 2 of its 3 fields.
- Plain, non-judgemental phrases are produced only for clear answers; the middle of the scale is left silent.

## Energy card (display only)

`src/lib/energy.ts` re-groups the **same answered fields** into four sub-scores for the card
(physical, mood, focus, capacity) and picks one of five bands: Running low (0–20), Low
(21–40), Steady (41–60), Good (61–80), Strong (81–100). A withheld score shows as **Steady**,
not a low band. Emoji are decorative and always paired with a text label; the palette never
uses red.

This module changes **no** stored value, no API and no server score — the overall score and
its three internal groups still come from `readiness.ts`.

## How the check-in feeds predictions

- The check-in gates the plan: until today's check-in is completed or skipped, `/api/predictions/plan` shows the check-in first and no numbers.
- When the check-in is present, its answers are features (a neutral, zero-centred "goodness" per field, plus an explicit missing indicator per field).
- The relationship is reported as an **association**, never a cause. Mood and energy are predictive inputs, not a diagnosis or a measure of worth.
- A skipped check-in widens uncertainty; it never becomes an invented value.

## Related docs

- [data-model.md](data-model.md) — the `checkins` and `checkin_history` tables
- [predictions.md](predictions.md) — how the check-in is used in a prediction
- [privacy-and-limits.md](privacy-and-limits.md) — optional fields and deleting check-in history
