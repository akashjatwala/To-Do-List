import type { DatabaseSync } from 'node:sqlite'

/**
 * Phase 2 data foundation: the tables the rest of the learning system depends
 * on. Everything here is additive — no existing table is modified — and every
 * statement is idempotent, so it is safe to run on every boot.
 *
 * Design notes
 * ------------
 * - Tags get stable ids. Task/tag links and versioned config snapshots point at
 *   those ids, so renaming or merging a tag never breaks a past record.
 * - Task configuration is versioned: a new row is appended whenever a versioned
 *   field changes, and old rows are never overwritten. `effective_from` marks
 *   when a version started to apply.
 * - Priority is stored exactly as the user set it. "No priority" is NULL, never
 *   a default such as "low".
 * - Sessions record real activity. The table is called `activity_sessions`
 *   because `sessions` is already taken by login sessions.
 * - Missing data is not zero. An explicit per-day status row is what
 *   distinguishes "I skipped it" from "I did not record anything".
 */
export function createFoundationSchema(db: DatabaseSync): void {
  db.exec(`
    -- Tags live per user and have stable ids.
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      normalized TEXT NOT NULL,
      merged_into_id INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (merged_into_id) REFERENCES tags(id)
    );

    -- Append-only trail of tag renames and merges.
    CREATE TABLE IF NOT EXISTS tag_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      normalized TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('create', 'rename', 'merge')),
      merged_into_id INTEGER,
      recorded_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Current task <-> tag membership (many-to-many).
    CREATE TABLE IF NOT EXISTS task_tags (
      task_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, tag_id),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Versioned task configuration. Never overwritten; a change appends a row.
    CREATE TABLE IF NOT EXISTS task_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      effective_from INTEGER NOT NULL,
      name TEXT NOT NULL,
      category TEXT,
      priority TEXT,
      frequency TEXT,
      frequency_config TEXT,
      target_duration INTEGER,
      preferred_time TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      UNIQUE (task_id, version),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Tag membership as it stood for a specific config version.
    CREATE TABLE IF NOT EXISTS task_config_tags (
      config_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (config_id, tag_id),
      FOREIGN KEY (config_id) REFERENCES task_configs(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- Real activity sessions. Several per day are allowed.
    CREATE TABLE IF NOT EXISTS activity_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      duration_minutes INTEGER NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- What the user explicitly said about a day, when there is no timed session.
    CREATE TABLE IF NOT EXISTS daily_activity_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'skipped', 'postponed')),
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, task_id, local_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    -- Optional extra questions. task_id set => asked for that task;
    -- tag_id set => a default suggested by a tag. Nothing is asked by default.
    CREATE TABLE IF NOT EXISTS context_questions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      task_id TEXT,
      tag_id INTEGER,
      key TEXT NOT NULL,
      prompt TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text', 'number', 'scale', 'boolean')),
      options_json TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- Answers to extra questions, recorded against a session.
    CREATE TABLE IF NOT EXISTS session_context (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (session_id, question_id),
      FOREIGN KEY (session_id) REFERENCES activity_sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES context_questions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_id, normalized);
    CREATE INDEX IF NOT EXISTS idx_tag_history_tag ON tag_history(tag_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_task_tags_tag ON task_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_task_configs_task ON task_configs(task_id, effective_from);
    CREATE INDEX IF NOT EXISTS idx_activity_sessions_task ON activity_sessions(user_id, task_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_activity_sessions_date ON activity_sessions(user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_daily_activity_status_task ON daily_activity_status(user_id, task_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_context_questions_task ON context_questions(user_id, task_id);
  `)
}

/**
 * Phase 2a: the read-only daily-state layer's own tables.
 *
 * These are deliberately separate from the check-in tables. The morning
 * check-in is the user's report and is never touched by this layer; the
 * evening review and the display preferences live here instead.
 *
 * - `day_reviews` stores the single optional evening tap. It is keyed by user
 *   and date, so there is at most one review per day, and it never overwrites
 *   or back-fills the morning check-in. Missing stays missing (no row).
 * - `state_prefs` lets the user hide the summary and the estimates. Absent row
 *   means the defaults (both shown).
 */
export function createStateSchema(db: DatabaseSync): void {
  db.exec(`
    -- One optional evening review per local day. Never writes to checkins.
    CREATE TABLE IF NOT EXISTS day_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      answer TEXT NOT NULL CHECK (answer IN ('much_better', 'better', 'about_same', 'worse', 'much_worse')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, local_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Display preferences for the state summary and estimates.
    CREATE TABLE IF NOT EXISTS state_prefs (
      user_id INTEGER PRIMARY KEY,
      show_summary INTEGER NOT NULL DEFAULT 1,
      show_estimates INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- The user's choice about a low-capacity suggestion, stored separately from
    -- the suggestion itself (as with the reschedule/drop suggestions). Nothing
    -- is changed automatically; this only remembers what the user decided.
    CREATE TABLE IF NOT EXISTS state_suggestion_choices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      suggestion_key TEXT NOT NULL,
      choice TEXT NOT NULL CHECK (choice IN ('accepted', 'dismissed')),
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, local_date, suggestion_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_day_reviews_user ON day_reviews(user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_suggestion_choices_user ON state_suggestion_choices(user_id, local_date);
  `)
}

/**
 * Phase 4: off days, the prediction log and the feedback trail.
 *
 * These are the learning system's own tables. They are deliberately separate
 * from the outcome tables: a prediction is **never** written back as an
 * observed result, and marking an off day never touches the sessions or the
 * per-day statuses already recorded. Missing stays missing.
 *
 * - `off_days` is one record per off period (type, start, end, optional note).
 *   `kind` is optional, because "off" with no reason has to work.
 * - `prediction_settings` holds the configurable thresholds: how many days of
 *   reduced confidence follow an off period, the exploration share, and the
 *   labelled-day count that moves an activity from stage 1 to stage 2.
 * - `predictions` logs what the system predicted, separately from outcomes, so
 *   calibration and timing can be checked later.
 * - `prediction_feedback` records whether a recommendation was shown, whether
 *   it was exploratory and whether the user followed it — again separate from
 *   both the predictions and the outcomes.
 */
export function createPredictionSchema(db: DatabaseSync): void {
  db.exec(`
    -- One row per off period. Never overwrites a session or a daily status.
    CREATE TABLE IF NOT EXISTS off_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT CHECK (kind IS NULL OR kind IN ('sick', 'travel', 'holiday', 'other')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      note TEXT,
      source TEXT NOT NULL DEFAULT 'user',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Configurable thresholds for the prediction layer (one row per user).
    CREATE TABLE IF NOT EXISTS prediction_settings (
      user_id INTEGER PRIMARY KEY,
      reduced_confidence_days INTEGER NOT NULL DEFAULT 3,
      exploration_share REAL NOT NULL DEFAULT 0.1,
      stage2_min_days INTEGER NOT NULL DEFAULT 10,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- The prediction log. Separate from activity_sessions and daily_activity_status.
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('baseline', 'model')),
      model_version TEXT NOT NULL,
      checkin_state TEXT NOT NULL,
      completion_probability REAL,
      target_probability REAL,
      expected_duration INTEGER,
      duration_low INTEGER,
      duration_high INTEGER,
      recommended_start INTEGER,
      recommended_end INTEGER,
      confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
      data_sufficiency_days INTEGER NOT NULL DEFAULT 0,
      stage INTEGER NOT NULL DEFAULT 1,
      exploratory INTEGER NOT NULL DEFAULT 0,
      explanation TEXT,
      inputs_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, local_date, task_id, model_version),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Feedback loop: shown / exploratory / followed, stored apart from both the
    -- predictions and the outcomes.
    CREATE TABLE IF NOT EXISTS prediction_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('time', 'plan', 'reschedule', 'drop')),
      exploratory INTEGER NOT NULL DEFAULT 0,
      shown INTEGER NOT NULL DEFAULT 0,
      followed INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, local_date, task_id, kind),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_off_days_user ON off_days(user_id, start_date, end_date);
    CREATE INDEX IF NOT EXISTS idx_predictions_user ON predictions(user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_prediction_feedback_user ON prediction_feedback(user_id, local_date);
  `)
}

/**
 * Phase 5: the model registry, the shadow-mode log and the retrain bookkeeping.
 *
 * These tables hold **models**, never observations. A trained model is stored as
 * a versioned row with its full metadata (data range, counts, feature list,
 * hyperparameters, seed, metrics, git commit) and its serialised payload, so any
 * version can be reloaded or rolled back. Previous versions are kept; nothing is
 * overwritten.
 *
 * - `ml_models`: one row per trained version. `status` moves
 *   candidate → champion → retired (or rejected). Only one champion per kind is
 *   ever used for serving; a `synthetic` model is flagged and can never be
 *   promoted into real serving.
 * - `ml_shadow`: a candidate's silent predictions next to the champion's on live
 *   data. `label` stays NULL until the day is actually labelled, so a shadow
 *   prediction is never mistaken for an outcome and is never shown to the user.
 * - `ml_retrain_state`: how many labelled observations existed at the last
 *   training, so retraining happens only once enough new ones have accumulated.
 *
 * Phase 6 adds three tables to the same module, all still about the system's own
 * bookkeeping and never about observations:
 * - `activity_outcome_links`: the check-in state beside the observed outcome of
 *   a (task, day), recomputed when activity is recorded.
 * - `ml_health_predictions`: a served model's output beside the baseline's for
 *   the same day, labelled only once the day's outcome is known.
 * - `ml_health`: the rolling verdict per model kind, including whether the
 *   system has fallen back to the baseline and why.
 * - `ml_retrain_log`: an append-only trail of retrain attempts for rate limiting.
 */
export function createMlSchema(db: DatabaseSync): void {
  db.exec(`
    -- One row per trained model version. Append-only; older versions are kept.
    CREATE TABLE IF NOT EXISTS ml_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('completion', 'target', 'duration', 'timing')),
      version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'champion', 'retired', 'rejected')),
      train_from TEXT NOT NULL,
      train_to TEXT NOT NULL,
      data_count INTEGER NOT NULL DEFAULT 0,
      labelled_count INTEGER NOT NULL DEFAULT 0,
      feature_names TEXT NOT NULL,
      hyperparams TEXT,
      seed INTEGER NOT NULL DEFAULT 0,
      metrics TEXT,
      git_commit TEXT,
      payload TEXT,
      notes TEXT,
      synthetic INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, version),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Shadow mode: a candidate's silent predictions beside the champion's.
    CREATE TABLE IF NOT EXISTS ml_shadow (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      candidate_id INTEGER NOT NULL,
      champion_id INTEGER,
      local_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      candidate_probability REAL,
      champion_probability REAL,
      baseline_probability REAL,
      label INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, candidate_id, local_date, task_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (candidate_id) REFERENCES ml_models(id) ON DELETE CASCADE
    );

    -- Retrain bookkeeping, so training only happens once enough new labels exist.
    CREATE TABLE IF NOT EXISTS ml_retrain_state (
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      last_trained_at INTEGER NOT NULL,
      last_labelled_count INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Phase 6: the linkage between a day's check-in and what actually happened.
    -- One row per (user, task, day), recomputed whenever activity is recorded or
    -- removed. It stores the observed outcome (performed / target met / minutes)
    -- beside the check-in state that preceded it, so learning can attach
    -- statistics to the right context without ever inventing a value. Missing
    -- stays NULL.
    CREATE TABLE IF NOT EXISTS activity_outcome_links (
      user_id INTEGER NOT NULL,
      task_id TEXT NOT NULL,
      local_date TEXT NOT NULL,
      checkin_state TEXT NOT NULL,
      performed INTEGER,
      target_achieved INTEGER,
      total_minutes INTEGER NOT NULL DEFAULT 0,
      tag_ids TEXT NOT NULL DEFAULT '[]',
      priority TEXT,
      config_version_id INTEGER,
      recorded_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, task_id, local_date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Phase 6: the live model health log. Each time a model is served, its
    -- probability/duration is stored beside the baseline's for the same
    -- (kind, day, task). The label is the observed outcome and stays NULL until
    -- the day is labelled — a prediction is never written back as an outcome.
    CREATE TABLE IF NOT EXISTS ml_health_predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      local_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      model_version TEXT NOT NULL,
      model_probability REAL,
      baseline_probability REAL,
      model_duration REAL,
      baseline_duration REAL,
      label INTEGER,
      label_duration REAL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, local_date, task_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Phase 6: the rolling health verdict per (user, kind). The fallback flag is 1
    -- when the live model is worse than the baseline over the recent window or its
    -- calibration has drifted past the gate; the reason is kept in plain words.
    CREATE TABLE IF NOT EXISTS ml_health (
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      window_days INTEGER NOT NULL DEFAULT 28,
      labelled_count INTEGER NOT NULL DEFAULT 0,
      model_brier REAL,
      baseline_brier REAL,
      model_ece REAL,
      baseline_ece REAL,
      model_mae REAL,
      baseline_mae REAL,
      fallback INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      evaluated_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, kind),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- Phase 6: an append-only trail of retrain attempts, used for rate limiting
    -- and for the plain-words health view.
    CREATE TABLE IF NOT EXISTS ml_retrain_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      trigger TEXT NOT NULL,
      new_labelled INTEGER NOT NULL DEFAULT 0,
      trained INTEGER NOT NULL DEFAULT 0,
      promoted INTEGER NOT NULL DEFAULT 0,
      detail TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_ml_models_user ON ml_models(user_id, kind, status);
    CREATE INDEX IF NOT EXISTS idx_ml_shadow_user ON ml_shadow(user_id, kind, candidate_id);
    CREATE INDEX IF NOT EXISTS idx_outcome_links_user ON activity_outcome_links(user_id, local_date);
    CREATE INDEX IF NOT EXISTS idx_ml_health_predictions_user ON ml_health_predictions(user_id, kind, local_date);
    CREATE INDEX IF NOT EXISTS idx_ml_retrain_log_user ON ml_retrain_log(user_id, created_at);
  `)
}
