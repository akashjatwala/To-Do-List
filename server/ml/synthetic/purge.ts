import { existsSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { OBSERVED_DIR } from './export-csv'

/**
 * Purge the synthetic dataset (Phase 3).
 *
 * One command removes the whole `synthetic-data/` tree — the CSVs, the ground
 * truth, the manifest, the checksums and the isolated `synthetic.db`. It is
 * deliberately narrow: it refuses to run unless the resolved path is exactly the
 * expected `synthetic-data/` directory, so a mistyped path can never delete the
 * app's real database or anything else.
 */

export interface PurgeResult {
  path: string
  removed: boolean
}

export function purgeSyntheticData(root = OBSERVED_DIR): PurgeResult {
  const target = resolve(root)
  const expected = resolve(OBSERVED_DIR)
  if (target !== expected) {
    throw new Error(`Refusing to purge "${target}": the synthetic dataset lives at "${expected}".`)
  }
  if (!existsSync(target)) return { path: target, removed: false }
  if (!statSync(target).isDirectory()) {
    throw new Error(`Refusing to purge "${target}": it is not a directory.`)
  }
  rmSync(target, { recursive: true, force: true })
  return { path: target, removed: true }
}
