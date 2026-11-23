/**
 * Coalesces repeated data refreshes.
 *
 * A burst of task mutations should not trigger one full bootstrap per call.
 * While a refresh is in flight, later callers share that promise and mark one
 * follow-up run. `invalidate` drops anything already in flight so a logout or
 * account deletion cannot repopulate the signed-out screen.
 */
export class RefreshCoalescer<T> {
  private generation = 0
  private activeRunId = 0
  private inFlight: Promise<void> | null = null
  private pending = false

  constructor(
    private readonly load: () => Promise<T>,
    private readonly apply: (value: T) => void,
  ) {}

  get currentGeneration(): number {
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation
  }

  invalidate(): void {
    this.generation += 1
    this.activeRunId += 1
    this.inFlight = null
    this.pending = false
  }

  async refresh(): Promise<void> {
    if (this.inFlight) {
      this.pending = true
      return this.inFlight
    }

    const generation = this.generation
    const runId = ++this.activeRunId
    const run = this.runRefresh(generation, runId)
    this.inFlight = run
    return run
  }

  private async runRefresh(generation: number, runId: number): Promise<void> {
    try {
      do {
        this.pending = false
        const value = await this.load()
        if (this.generation === generation) this.apply(value)
      } while (this.pending && this.generation === generation)
    } finally {
      if (this.activeRunId === runId) this.inFlight = null
    }
  }
}
