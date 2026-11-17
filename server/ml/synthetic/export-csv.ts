import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SyntheticConfig } from './config'
import { stableStringify } from './config'
import { countRows, type SyntheticModel } from './model'
import { iso, toCsv, type Cell } from './csv'

/**
 * CSV export.
 *
 * Every file is CSV (never JSON), UTF-8, LF line endings, with consistent
 * `snake_case` column names taken from the app's own schema. Every observed row
 * carries `person_id` first and `synthetic = 1` last. Ground truth is written to
 * a separate folder that only the harness reads, and no ground-truth column ever
 * appears in an observed file.
 *
 * Ids and timestamps were assigned by the generator, so the same seed produces
 * byte-identical files; a `checksums.csv` records the SHA-256 of each file so
 * that can be verified.
 */

export const OBSERVED_DIR = 'synthetic-data'
export const GROUND_TRUTH_DIR = 'synthetic-data/ground-truth'

export interface WrittenFile {
  name: string
  path: string
  rows: number
  sha256: string
}

export interface ExportResult {
  dir: string
  groundTruthDir: string
  files: WrittenFile[]
  totalRows: number
  configHash: string
}

export interface ExportMeta {
  /** The cutoff the export represents; equals `endDate` for a normal run. */
  asOfDate: string
  /**
   * Folder under `synthetic-data/` to write into. Defaults to the person id.
   * The as-of command passes `person-001/as-of-2026-06-01` so the full export is
   * never overwritten.
   */
  dirName?: string
  /** Where to write `checksums.csv`; defaults to `synthetic-data/checksums.csv`. */
  checksumPath?: string
}

function writeFile(path: string, content: string): { sha256: string } {
  writeFileSync(path, content, { encoding: 'utf8' })
  return { sha256: createHash('sha256').update(content, 'utf8').digest('hex') }
}

/** Write all observed files plus the manifest and a checksum index. */
export function exportModel(model: SyntheticModel, config: SyntheticConfig, meta: ExportMeta): ExportResult {
  const personId = config.personId
  const dir = join(OBSERVED_DIR, meta.dirName ?? personId)
  const groundTruthDir = GROUND_TRUTH_DIR
  mkdirSync(dir, { recursive: true })
  mkdirSync(groundTruthDir, { recursive: true })

  const files: WrittenFile[] = []
  const record = (name: string, header: string[], rows: Cell[][]) => {
    const path = join(dir, name)
    const { sha256 } = writeFile(path, toCsv(header, rows))
    files.push({ name, path, rows: rows.length, sha256 })
  }

  const obs = (row: Cell[]) => [personId, ...row, 1]

  record(
    'tasks.csv',
    ['person_id', 'id', 'user_id', 'text', 'done', 'created_at', 'due', 'position', 'progress', 'priority', 'tags', 'recurrence', 'duration', 'recurrence_config', 'preferred_time', 'synthetic'],
    model.tasks.map((row) =>
      obs([row.id, row.user_id, row.text, row.done, iso(row.created_at), row.due === null ? null : iso(row.due), row.position, row.progress, row.priority, row.tags, row.recurrence, row.duration, row.recurrence_config, row.preferred_time]),
    ),
  )

  record(
    'tags.csv',
    ['person_id', 'id', 'user_id', 'name', 'normalized', 'merged_into_id', 'created_at', 'synthetic'],
    model.tags.map((row) => obs([row.id, row.user_id, row.name, row.normalized, row.merged_into_id, iso(row.created_at)])),
  )

  record(
    'tag_history.csv',
    ['person_id', 'id', 'tag_id', 'user_id', 'name', 'normalized', 'action', 'merged_into_id', 'recorded_at', 'synthetic'],
    model.tagHistory.map((row) => obs([row.id, row.tag_id, row.user_id, row.name, row.normalized, row.action, row.merged_into_id, iso(row.recorded_at)])),
  )

  record(
    'task_tags.csv',
    ['person_id', 'task_id', 'tag_id', 'user_id', 'created_at', 'synthetic'],
    model.taskTags.map((row) => obs([row.task_id, row.tag_id, row.user_id, iso(row.created_at)])),
  )

  record(
    'task_configs.csv',
    ['person_id', 'id', 'task_id', 'user_id', 'version', 'effective_from', 'name', 'category', 'priority', 'frequency', 'frequency_config', 'target_duration', 'preferred_time', 'active', 'created_at', 'tag_ids', 'synthetic'],
    model.taskConfigs.map((row) =>
      obs([row.id, row.task_id, row.user_id, row.version, iso(row.effective_from), row.name, row.category, row.priority, row.frequency, row.frequency_config, row.target_duration, row.preferred_time, row.active, iso(row.created_at), row.tag_ids.join('|')]),
    ),
  )

  record(
    'activity_sessions.csv',
    ['person_id', 'id', 'user_id', 'task_id', 'local_date', 'started_at', 'ended_at', 'duration_minutes', 'note', 'source', 'created_at', 'updated_at', 'synthetic'],
    model.sessions.map((row) =>
      obs([row.id, row.user_id, row.task_id, row.local_date, iso(row.started_at), row.ended_at === null ? null : iso(row.ended_at), row.duration_minutes, row.note, row.source, iso(row.created_at), iso(row.updated_at)]),
    ),
  )

  record(
    'daily_activity_status.csv',
    ['person_id', 'id', 'user_id', 'task_id', 'local_date', 'status', 'reason', 'source', 'created_at', 'updated_at', 'synthetic'],
    model.dailyStatus.map((row) => obs([row.id, row.user_id, row.task_id, row.local_date, row.status, row.reason, row.source, iso(row.created_at), iso(row.updated_at)])),
  )

  record(
    'checkins.csv',
    ['person_id', 'id', 'user_id', 'date', 'feeling', 'energy', 'motivation', 'sleep', 'stress', 'free_time', 'focus', 'body', 'workload', 'skipped', 'context', 'source', 'created_at', 'updated_at', 'synthetic'],
    model.checkins.map((row) =>
      obs([row.id, row.user_id, row.date, row.feeling, row.energy, row.motivation, row.sleep, row.stress, row.free_time, row.focus, row.body, row.workload, row.skipped, row.context, row.source, iso(row.created_at), iso(row.updated_at)]),
    ),
  )

  record(
    'checkin_history.csv',
    ['person_id', 'id', 'checkin_id', 'user_id', 'date', 'feeling', 'energy', 'motivation', 'sleep', 'stress', 'free_time', 'focus', 'body', 'workload', 'skipped', 'context', 'source', 'recorded_at', 'synthetic'],
    model.checkinHistory.map((row) =>
      obs([row.id, row.checkin_id, row.user_id, row.date, row.feeling, row.energy, row.motivation, row.sleep, row.stress, row.free_time, row.focus, row.body, row.workload, row.skipped, row.context, row.source, iso(row.recorded_at)]),
    ),
  )

  record(
    'day_reviews.csv',
    ['person_id', 'id', 'user_id', 'local_date', 'answer', 'created_at', 'updated_at', 'synthetic'],
    model.reviews.map((row) => obs([row.id, row.user_id, row.local_date, row.answer, iso(row.created_at), iso(row.updated_at)])),
  )

  record(
    'context_questions.csv',
    ['person_id', 'id', 'user_id', 'task_id', 'tag_id', 'key', 'prompt', 'kind', 'options_json', 'position', 'active', 'created_at', 'synthetic'],
    model.contextQuestions.map((row) => obs([row.id, row.user_id, row.task_id, row.tag_id, row.key, row.prompt, row.kind, row.options_json, row.position, row.active, iso(row.created_at)])),
  )

  record(
    'session_context.csv',
    ['person_id', 'id', 'session_id', 'question_id', 'value', 'created_at', 'synthetic'],
    model.sessionContext.map((row) => obs([row.id, row.session_id, row.question_id, row.value, iso(row.created_at)])),
  )

  record(
    'state_suggestion_choices.csv',
    ['person_id', 'id', 'user_id', 'local_date', 'suggestion_key', 'choice', 'created_at', 'synthetic'],
    model.suggestionChoices.map((row) => obs([row.id, row.user_id, row.local_date, row.suggestion_key, row.choice, iso(row.created_at)])),
  )

  // Layer files (each flagged synthetic; each controlled by its own switch).
  if (config.layers.offDays) {
    record(
      'layer_off_days.csv',
      ['person_id', 'kind', 'start_date', 'end_date', 'reason', 'added_later', 'synthetic'],
      model.offDays.map((row) => [row.person_id, row.kind, row.start_date, row.end_date, row.reason, row.added_later, row.synthetic]),
    )
  }
  if (config.layers.recommendations) {
    record(
      'layer_recommendations.csv',
      ['person_id', 'id', 'local_date', 'task_id', 'kind', 'exploratory', 'response', 'created_at', 'synthetic'],
      model.recommendations.map((row) => [row.person_id, row.id, row.local_date, row.task_id, row.kind, row.exploratory, row.response, iso(row.created_at), row.synthetic]),
    )
  }
  if (config.layers.regimeChange) {
    record(
      'layer_regime_change.csv',
      ['person_id', 'at_date', 'label', 'completion_shift', 'free_time_shift', 'energy_shift', 'calm_stretch_days', 'synthetic'],
      model.regimeChanges.map((row) => [row.person_id, row.at_date, row.label, row.completion_shift, row.free_time_shift, row.energy_shift, row.calm_stretch_days, row.synthetic]),
    )
  }
  if (config.layers.liveReplay) {
    record(
      'layer_live_replay.csv',
      ['person_id', 'step', 'local_date', 'prediction', 'prediction_source', 'outcome', 'synthetic'],
      model.liveReplay.map((row) => [row.person_id, row.step, row.local_date, row.prediction, row.prediction_source, row.outcome, row.synthetic]),
    )
  }

  // Ground truth (separate folder, never mixed with observed files).
  const gtFiles: WrittenFile[] = []
  const gtRecord = (name: string, header: string[], rows: Cell[][]) => {
    const path = join(groundTruthDir, name)
    const { sha256 } = writeFile(path, toCsv(header, rows))
    gtFiles.push({ name: join('ground-truth', name), path, rows: rows.length, sha256 })
  }
  gtRecord(
    'params.csv',
    ['person_id', 'seed', 'key', 'value', 'synthetic'],
    model.gtParams.map((row) => [row.person_id, row.seed, row.key, row.value, 1]),
  )
  gtRecord(
    'daily_probability.csv',
    ['person_id', 'date', 'task_id', 'true_probability', 'true_performed', 'off_day', 'episode', 'regime', 'synthetic'],
    model.gtDaily.map((row) => [row.person_id, row.date, row.task_id, row.true_probability, row.true_performed, row.off_day, row.episode, row.regime, 1]),
  )
  gtRecord(
    'hidden_state.csv',
    ['person_id', 'date', 'feeling', 'energy', 'motivation', 'sleep', 'stress', 'free_time', 'focus', 'body', 'workload', 'off_day', 'episode', 'regime', 'cycle', 'synthetic'],
    model.gtHidden.map((row) => [row.person_id, row.date, row.feeling, row.energy, row.motivation, row.sleep, row.stress, row.free_time, row.focus, row.body, row.workload, row.off_day, row.episode, row.regime, row.cycle, 1]),
  )
  gtRecord(
    'off_days.csv',
    ['person_id', 'kind', 'start_date', 'end_date', 'reason', 'added_later', 'synthetic'],
    model.gtOffDays.map((row) => [row.person_id, row.kind, row.start_date, row.end_date, row.reason, row.added_later, 1]),
  )
  gtRecord(
    'recommendations.csv',
    ['person_id', 'local_date', 'task_id', 'kind', 'exploratory', 'response', 'true_effect', 'synthetic'],
    model.gtRecommendations.map((row) => [row.person_id, row.local_date, row.task_id, row.kind, row.exploratory, row.response, row.true_effect, 1]),
  )

  const totalRows = countRows(model)
  const configHash = createHash('sha256').update(stableStringify(config), 'utf8').digest('hex')

  const manifestRows: Cell[][] = [
    ['person_id', personId],
    ['label', config.personLabel],
    ['seed', config.seed],
    ['generator_version', config.generatorVersion],
    ['config_hash', configHash],
    ['start_date', model.person.startDate],
    ['end_date', config.endDate],
    ['as_of_date', meta.asOfDate],
    ['history_days', config.historyDays],
    ['num_tasks', model.tasks.length],
    ['pending_tail_days', config.pendingTailDays],
    ['layers', Object.entries(config.layers).filter(([, on]) => on).map(([name]) => name).join('|')],
    ['synthetic', 1],
    ['total_rows', totalRows],
    ...files.map((file) => [`file:${file.name}`, file.rows] as Cell[]),
    ...gtFiles.map((file) => [`file:${file.name}`, file.rows] as Cell[]),
  ]
  writeFile(join(dir, 'manifest.csv'), toCsv(['key', 'value'], manifestRows))

  const checksumRows: Cell[][] = [...files, ...gtFiles].map((file) => [file.name, file.rows, file.sha256])
  const checksumPath = meta.checksumPath ?? join(OBSERVED_DIR, 'checksums.csv')
  mkdirSync(join(checksumPath, '..'), { recursive: true })
  writeFile(checksumPath, toCsv(['file', 'rows', 'sha256'], checksumRows))

  return { dir, groundTruthDir, files, totalRows, configHash }
}
