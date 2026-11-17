/**
 * Deterministic random number generation for the synthetic data generator.
 *
 * Everything the generator draws comes from here, seeded from a single number,
 * so a run is reproducible: the same seed always produces byte-identical files
 * (the export layer checks this with checksums). There is no use of
 * `Math.random()` anywhere in the synthetic package.
 *
 * `fork(label)` derives an independent stream from the parent seed, so two
 * parts of the generator (say, off days and recommendations) never consume each
 * other's draws. Adding a new fork cannot shift an existing stream.
 */

export type Rng = () => number

/** FNV-1a over the string form of every part, used to mix labels into a seed. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 2166136261 >>> 0
  for (const part of parts) {
    const text = String(part)
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h = (h ^ 0x9e3779b9) >>> 0
    h = Math.imul(h, 2246822519) >>> 0
  }
  return h >>> 0
}

/** Small, fast, well-behaved PRNG (same one the sample seeder uses). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface RngTools {
  /** The raw uniform stream in [0, 1). */
  next: Rng
  /** Inclusive integer in [min, max]. */
  int(min: number, max: number): number
  /** Uniform float in [min, max). */
  float(min: number, max: number): number
  /** True with probability p. */
  bool(p: number): boolean
  /** One item, uniform. */
  pick<T>(items: readonly T[]): T
  /** Index into a list of non-negative weights. */
  pickIndex(weights: readonly number[]): number
  /** One item chosen by weight. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T
  /** Normal draw (Box–Muller), mean 0 and sd 1 by default. */
  gaussian(mean?: number, sd?: number): number
  /** A shuffled copy. */
  shuffle<T>(items: readonly T[]): T[]
  /** Up to `count` distinct items, uniform. */
  sample<T>(items: readonly T[], count: number): T[]
  /** An independent stream derived from the same master seed. */
  fork(label: string): RngTools
}

export function makeRng(seed: number, masterSeed = seed): RngTools {
  const next = mulberry32(seed)

  const tools: RngTools = {
    next,
    int(min, max) {
      if (max <= min) return min
      return min + Math.floor(next() * (max - min + 1))
    },
    float(min, max) {
      return min + next() * (max - min)
    },
    bool(p) {
      return next() < p
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick() needs at least one item')
      return items[Math.floor(next() * items.length)]
    },
    pickIndex(weights) {
      const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0)
      if (total <= 0) return 0
      let target = next() * total
      for (let i = 0; i < weights.length; i += 1) {
        target -= Math.max(0, weights[i])
        if (target < 0) return i
      }
      return weights.length - 1
    },
    weighted(items) {
      if (items.length === 0) throw new Error('weighted() needs at least one item')
      const index = tools.pickIndex(items.map(([, weight]) => weight))
      return items[index][0]
    },
    gaussian(mean = 0, sd = 1) {
      let u = 0
      let v = 0
      while (u === 0) u = next()
      while (v === 0) v = next()
      const standard = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
      return mean + standard * sd
    },
    shuffle(items) {
      const out = [...items]
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1))
        ;[out[i], out[j]] = [out[j], out[i]]
      }
      return out
    },
    sample(items, count) {
      return tools.shuffle(items).slice(0, Math.max(0, Math.min(count, items.length)))
    },
    fork(label) {
      return makeRng(hashSeed(masterSeed, label), masterSeed)
    },
  }

  return tools
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/** Standard logistic, used to turn a score into a probability. */
export function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value)
    return 1 / (1 + z)
  }
  const z = Math.exp(value)
  return z / (1 + z)
}
