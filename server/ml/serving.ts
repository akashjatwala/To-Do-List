import type { DatabaseSync } from 'node:sqlite'
import {
  computeFeatures,
  featureNamesFor,
  gatherFeatureSnapshot,
  monthsBetween,
  predictionMinuteFor,
  DEFAULT_PREDICTION_MINUTE,
  type FeatureVocabulary,
} from './features'
import { loadChampionArtifact } from './registry'
import { predictClassifier, type ClassifierArtifact } from './training'
import { epochAtMinute, predictTask, type PredictContext, type TaskPrediction, type PredictOptions } from './predictors'
import { isFallbackActive, logHealthPredictionSafe } from './health'

/**
 * Serving the champion with a safe fallback.
 *
 * The served number is always produced the same way the training features were:
 * through the shared feature module, with the champion's own vocabulary, snapped
 * to the most recent trained prediction time. If anything is wrong — no champion,
 * an unreadable payload, a feature-name or prediction-time mismatch, a non-finite
 * or out-of-range score — the code **falls back to the baseline predictor** and
 * says why. The user is never shown a broken number, and a champion is never
 * trusted blindly.
 *
 * A second reason to fall back is the live **model health** check
 * (`health.ts`). When a served model has been scoring worse than the baseline on
 * the user's own recent days, the baseline is used for that kind until the next
 * retrain, and the model's output is still logged (never served) so it can be
 * re-judged. The champion supplies only the completion probability; target
 * probability, expected duration, the recommended time window and the
 * explanation still come from the baseline predictor.
 */

export interface ServeResult {
  prediction: TaskPrediction
  usedModel: boolean
  reason: string
}

function observedMonths(db: DatabaseSync, userId: number, today: string): number {
  const row = db
    .prepare('SELECT MIN(local_date) AS d FROM activity_sessions WHERE user_id = ?')
    .get(userId) as unknown as { d: string | null }
  if (!row.d) return 0
  return monthsBetween(row.d, today)
}

function validProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * A champion is only used when its recorded columns, in order, are exactly the
 * columns the shared feature module would build today, and when it was trained
 * for the prediction time being served. A length check alone cannot catch a
 * reordered or renamed column. Older artifacts without a grid count as 08:00.
 */
function artifactMatches(
  artifact: { featureNames: string[]; vocabulary: FeatureVocabulary; predictionMinutes?: number[] },
  predictionMinute: number,
): boolean {
  if (!artifact.vocabulary || typeof artifact.vocabulary !== 'object') return false
  if (!Array.isArray(artifact.featureNames)) return false
  const expected = featureNamesFor(artifact.vocabulary)
  if (expected.length !== artifact.featureNames.length) return false
  if (expected.some((name, i) => name !== artifact.featureNames[i])) return false
  const grid =
    Array.isArray(artifact.predictionMinutes) && artifact.predictionMinutes.length > 0
      ? artifact.predictionMinutes
      : [DEFAULT_PREDICTION_MINUTE]
  return grid.includes(predictionMinute)
}

/**
 * Serve one task: the champion when it is available, sane and healthy, otherwise
 * the baseline predictor. Returns null only when the baseline itself cannot predict
 * (missing task or an off day).
 */
export function serveTask(
  db: DatabaseSync,
  userId: number,
  taskId: string,
  context: PredictContext,
  options: PredictOptions = {},
): ServeResult | null {
  const baseline = predictTask(db, userId, taskId, context, options)
  if (!baseline) return null

  const completion = loadChampionArtifact(db, userId, 'completion')
  if (!completion) {
    return { prediction: baseline, usedModel: false, reason: 'No champion model is registered; the baseline predictor is served.' }
  }

  // Never use a time that has not happened yet: snap to the most recent cutoff
  // the model was trained at. Past dates have no time-of-day, so they use 08:00.
  const predictionMinute = predictionMinuteFor(context.nowMinutes)
  try {
    const snapshot = gatherFeatureSnapshot(db, {
      userId,
      taskId,
      date: context.date,
      today: context.today,
      asOfEpoch: epochAtMinute(context.date, predictionMinute) - 1,
      nowMinutes: predictionMinute,
      priorRate: context.priorRate,
      tagStats: context.tagStats,
      monthsOfData: observedMonths(db, userId, context.today),
      stage2MinDays: context.settings.stage2MinDays,
    })

    const overrides: Partial<TaskPrediction> = {}
    const notes: string[] = []
    let version = baseline.modelVersion
    let usedModel = false

    // A champion whose live health is on the baseline is not served.
    const onFallback = isFallbackActive(db, userId, 'completion')

    let modelCompletion: number | null = null

    if (completion.artifact.kind === 'completion') {
      const artifact = completion.artifact as ClassifierArtifact
      if (!artifactMatches(artifact, predictionMinute)) {
        return { prediction: baseline, usedModel: false, reason: 'The champion did not match its recorded feature list or prediction time; the baseline is served.' }
      }
      const features = computeFeatures(snapshot, artifact.vocabulary)
      const probability = predictClassifier(artifact, features)
      if (!validProbability(probability)) {
        return { prediction: baseline, usedModel: false, reason: 'The champion returned an invalid probability; the baseline is served.' }
      }
      modelCompletion = probability
      if (onFallback) {
        notes.push(`completion from ${completion.row.version} is being re-checked, so the baseline is used for now`)
      } else {
        overrides.completionProbability = probability
        version = completion.row.version
        usedModel = true
        notes.push(`completion from ${version} (${artifact.type})`)
      }
    }

    // Log what the model and the baseline would each say for this day, so the
    // live health can be scored later. This is a log — never a served value, and
    // never an outcome. A logging failure is swallowed and cannot break serving.
    if (completion) {
      logHealthPredictionSafe(db, userId, {
        kind: 'completion',
        date: context.date,
        taskId,
        modelVersion: completion.row.version,
        modelProbability: modelCompletion,
        baselineProbability: baseline.completionProbability,
      })
    }

    if (!usedModel) {
      return {
        prediction: baseline,
        usedModel: false,
        reason:
          notes.length > 0
            ? `The champion is not being served right now: ${notes.join('; ')}. The baseline is served.`
            : 'The champion produced no usable output; the baseline is served.',
      }
    }

    return {
      prediction: {
        ...baseline,
        ...overrides,
        source: 'model',
        modelVersion: version,
        explanation: `${baseline.explanation} Served by model ${version} (${notes.join('; ')}).`,
      },
      usedModel: true,
      reason: `Served by model ${version}: ${notes.join('; ')}.`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { prediction: baseline, usedModel: false, reason: `The champion could not be loaded (${message}); the baseline is served.` }
  }
}
