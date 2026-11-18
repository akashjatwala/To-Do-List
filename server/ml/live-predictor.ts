/**
 * The one prediction entry point used by the HTTP routes.
 *
 * It serves the champion model when one is available, sane and healthy, and
 * falls back to the baseline predictor otherwise. `ML_DISABLE_MODEL_SERVING=1`
 * keeps the old baseline-only behaviour for comparison or in an emergency;
 * changing it needs a server restart.
 */
import type { DatabaseSync } from 'node:sqlite'
import { predictTask, type TaskPredictor } from './predictors'
import { serveTask } from './serving'

export function makeLivePredictor(disableModel: boolean): TaskPredictor {
  return (db: DatabaseSync, userId: number, taskId: string, context, options = {}) => {
    if (disableModel) return predictTask(db, userId, taskId, context, options)
    return serveTask(db, userId, taskId, context, options)?.prediction ?? null
  }
}

/** Set at startup; see `docs/operations.md`. */
export const livePredictor = makeLivePredictor(process.env.ML_DISABLE_MODEL_SERVING === '1')
