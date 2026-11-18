/**
 * Small numeric helpers shared by the candidate models (Phase 5, §2).
 *
 * Deliberately tiny and dependency-free: the models here are regularised linear
 * models and small trees, trained by fixed, deterministic routines. No random
 * initialisation and no library — the same input always gives the same model.
 */

export interface Example {
  x: number[]
  y: number
  w: number
}

export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z))
  const e = Math.exp(z)
  return e / (1 + e)
}

export function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

export interface Standardizer {
  mean: number[]
  std: number[]
}

/** Per-feature weighted mean and standard deviation. Zero-variance features keep std 1. */
export function fitStandardizer(rows: Example[], nFeatures: number): Standardizer {
  const mean = new Array<number>(nFeatures).fill(0)
  const std = new Array<number>(nFeatures).fill(1)
  let weightSum = 0
  for (const row of rows) weightSum += row.w
  if (weightSum <= 0) return { mean, std }
  for (let j = 0; j < nFeatures; j += 1) {
    let sum = 0
    for (const row of rows) sum += row.w * (row.x[j] ?? 0)
    mean[j] = sum / weightSum
  }
  for (let j = 0; j < nFeatures; j += 1) {
    let sum = 0
    for (const row of rows) sum += row.w * ((row.x[j] ?? 0) - mean[j]) ** 2
    const variance = sum / weightSum
    std[j] = variance > 1e-12 ? Math.sqrt(variance) : 1
  }
  return { mean, std }
}

export function standardize(x: number[], standardizer: Standardizer): number[] {
  return x.map((value, j) => (value - standardizer.mean[j]) / standardizer.std[j])
}

export function dot(a: number[], b: number[]): number {
  let sum = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) sum += a[i] * b[i]
  return sum
}

/** A tiny deterministic PRNG, used only where a seed is required. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
