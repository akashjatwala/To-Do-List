import type { SyntheticModel } from './model'
import { emptyModel } from './model'
import { endOfLocalDay } from './calendar'
import type { SyntheticConfig } from './config'
import { exportModel, type ExportResult } from './export-csv'

/**
 * As-of rebuild (Phase 3).
 *
 * The full model is generated deterministically, then everything the person
 * could not yet have known at the cutoff is dropped: no session, status,
 * check-in, review or suggestion stamped after the end of the as-of day
 * survives, and no ground-truth row after that day either. The result is the
 * dataset exactly as it stood at the cutoff, which is what a leak-free
 * backtest needs.
 *
 * Two rules this protects, in code:
 * - A pending day is never given a negative label. Days at or after the cutoff
 *   carry no status, so they read as pending, not as skipped.
 * - No future leakage. Every surviving timestamp is at or before the cutoff.
 */

export interface AsOfResult extends ExportResult {
  asOfDate: string
  cutoff: number
}

/** The last millisecond of the as-of day — the visibility cutoff. */
export function asOfCutoff(asOfDate: string): number {
  return endOfLocalDay(asOfDate)
}

/** A copy of the model with every record after the cutoff removed. */
export function filterModelAsOf(model: SyntheticModel, asOfDate: string): SyntheticModel {
  const cutoff = asOfCutoff(asOfDate)
  const out = emptyModel(model.person, model.userId, model.coverage)
  const kept = (date: string) => date <= asOfDate

  out.states = model.states.filter((row) => kept(row.date))
  out.outcomes = model.outcomes.filter((row) => kept(row.date))

  out.tags = model.tags.filter((row) => row.created_at <= cutoff)
  out.tagHistory = model.tagHistory.filter((row) => row.recorded_at <= cutoff)
  out.tasks = model.tasks.filter((row) => row.created_at <= cutoff)
  out.taskConfigs = model.taskConfigs.filter((row) => row.effective_from <= cutoff)
  const taskIds = new Set(out.tasks.map((row) => row.id))
  const configIds = new Set(out.taskConfigs.map((row) => row.id))
  out.taskTags = model.taskTags.filter((row) => taskIds.has(row.task_id) && row.created_at <= cutoff)

  out.sessions = model.sessions.filter((row) => kept(row.local_date) && row.created_at <= cutoff)
  out.dailyStatus = model.dailyStatus.filter((row) => kept(row.local_date) && row.created_at <= cutoff)
  out.checkins = model.checkins.filter((row) => kept(row.date) && row.created_at <= cutoff)
  const checkinIds = new Set(out.checkins.map((row) => row.id))
  out.checkinHistory = model.checkinHistory.filter((row) => checkinIds.has(row.checkin_id) && row.recorded_at <= cutoff)
  out.reviews = model.reviews.filter((row) => kept(row.local_date) && row.created_at <= cutoff)

  out.contextQuestions = model.contextQuestions.filter((row) => row.created_at <= cutoff)
  const sessionIds = new Set(out.sessions.map((row) => row.id))
  out.sessionContext = model.sessionContext.filter((row) => sessionIds.has(row.session_id) && row.created_at <= cutoff)
  out.suggestionChoices = model.suggestionChoices.filter((row) => kept(row.local_date) && row.created_at <= cutoff)

  out.offDays = model.offDays.filter((row) => row.start_date <= asOfDate)
  out.recommendations = model.recommendations.filter((row) => kept(row.local_date) && row.created_at <= cutoff)
  out.regimeChanges = model.regimeChanges.filter((row) => row.at_date <= asOfDate)
  out.liveReplay = model.liveReplay.filter((row) => kept(row.local_date))

  out.gtParams = model.gtParams
  out.gtDaily = model.gtDaily.filter((row) => kept(row.date))
  out.gtHidden = model.gtHidden.filter((row) => kept(row.date))
  out.gtOffDays = model.gtOffDays.filter((row) => row.start_date <= asOfDate)
  out.gtRecommendations = model.gtRecommendations.filter((row) => kept(row.local_date))

  void configIds
  return out
}

/** Export the model restricted to what was known at the end of `asOfDate`. */
export function exportAsOf(
  model: SyntheticModel,
  config: SyntheticConfig,
  asOfDate: string,
): AsOfResult {
  const filtered = filterModelAsOf(model, asOfDate)
  const result = exportModel(filtered, config, {
    asOfDate,
    dirName: `${config.personId}/as-of-${asOfDate}`,
    checksumPath: `synthetic-data/${config.personId}/as-of-${asOfDate}/checksums.csv`,
  })
  return { ...result, asOfDate, cutoff: asOfCutoff(asOfDate) }
}
