/**
 * Small numeric helpers shared by the candidate models.
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

