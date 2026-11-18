import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from './config'
import { generateModel, estimateRows, planGeneration } from './generate'
import { countRows } from './model'
import { buildCoverageReport } from './coverage'
import { runModelChecks, runPhase2aChecks, runPhase4Checks, combineReports, type Phase4GroundTruth } from './checks'
import { filterModelAsOf, asOfCutoff } from './as-of'
import { writeModel } from './writer'
import { canPromoteModel, openSyntheticDb, registerSyntheticModel, createSyntheticUser } from './isolation'
import { purgeSyntheticData } from './purge'
import { toCsv, parseCsv, parseCsvRecords, iso, fromIso } from './csv'
import { endOfLocalDay, startOfLocalDay } from './calendar'

/**
 * Tests for the Phase 3 synthetic dataset.
 *
 * These run the generator in memory (never writing to `synthetic-data/`) and
 * check the properties the brief demands: reproducible output, the coverage
 * matrix, honest labelling, no leakage, and isolation from the real database and
 * the real model registry. No test claims accuracy — there is no model yet.
 */

const QUICK = resolveConfig({ quick: true })
const FULL = resolveConfig()

test('CSV round-trips quoted fields, commas and newlines', () => {
  const header = ['a', 'b', 'c']
  const rows = [
    ['plain', 'has,comma', 'has"quote'],
    ['multi\nline', '', 'x'],
  ]
  const text = toCsv(header, rows)
  const parsed = parseCsv(text)
  assert.deepEqual(parsed[0], header)
  assert.deepEqual(parsed[1], rows[0])
  assert.deepEqual(parsed[2], rows[1])
  const records = parseCsvRecords(text)
  assert.equal(records[0].b, 'has,comma')
  assert.equal(records[1].a, 'multi\nline')
  // An empty cell stays empty, never zero.
  assert.equal(records[1].b, '')
})

test('ISO timestamps survive a round trip', () => {
  const ms = 1_763_000_000_000
  assert.equal(fromIso(iso(ms)), ms)
})

test('the generator is deterministic for a fixed seed', () => {
  const a = generateModel(QUICK, 1)
  const b = generateModel(QUICK, 1)
  assert.deepEqual(a.sessions, b.sessions)
  assert.deepEqual(a.checkins, b.checkins)
  assert.deepEqual(a.dailyStatus, b.dailyStatus)
  assert.deepEqual(a.gtDaily, b.gtDaily)
  assert.equal(countRows(a), countRows(b))
})

test('a different seed changes the data', () => {
  const a = generateModel(QUICK, 1)
  const b = generateModel({ ...QUICK, seed: QUICK.seed + 1 }, 1)
  assert.notEqual(countRows(a), countRows(b))
})

test('quick config meets its coverage matrix and the row cap', () => {
  const model = generateModel(QUICK, 1)
  const coverage = buildCoverageReport(model.coverage, QUICK.coverage, countRows(model), QUICK.maxRows)
  assert.equal(coverage.allOk, true, coverage.missing.join('; '))
  assert.equal(coverage.capOk, true)
})

test('full config meets its coverage matrix and lands in the target band', () => {
  const model = generateModel(FULL, 1)
  const rows = countRows(model)
  const coverage = buildCoverageReport(model.coverage, FULL.coverage, rows, FULL.maxRows)
  assert.equal(coverage.allOk, true, coverage.missing.join('; '))
  assert.equal(coverage.capOk, true)
  assert.ok(rows >= FULL.targetRows[0] && rows <= FULL.targetRows[1], `rows ${rows} outside ${FULL.targetRows.join('–')}`)
})

test('quick config lands in its target band', () => {
  const rows = countRows(generateModel(QUICK, 1))
  assert.ok(rows >= QUICK.targetRows[0] && rows <= QUICK.targetRows[1], `rows ${rows} outside ${QUICK.targetRows.join('–')}`)
})

test('the data-quality and leakage checks pass', () => {
  const model = generateModel(QUICK, 1)
  const coverage = buildCoverageReport(model.coverage, QUICK.coverage, countRows(model), QUICK.maxRows)
  const checks = combineReports(QUICK.personId, QUICK.endDate, runModelChecks(model, QUICK, coverage))
  assert.equal(checks.allOk, true, checks.checks.filter((row) => !row.ok).map((row) => `${row.name}: ${row.detail}`).join('; '))
})

test('pending days carry no labels and no sessions', () => {
  const model = generateModel(FULL, 1)
  const lastEvaluated = model.person.dates.length - FULL.pendingTailDays - 1
  const boundary = model.person.dates[lastEvaluated]
  assert.ok(model.checkins.every((row) => row.date <= boundary))
  assert.ok(model.dailyStatus.every((row) => row.local_date <= boundary))
  assert.ok(model.sessions.every((row) => row.local_date <= boundary))
})

test('every observed row is flagged synthetic', () => {
  const model = generateModel(QUICK, 1)
  assert.ok(model.sessions.every((row) => row.source === 'synthetic'))
  assert.ok(model.checkins.every((row) => row.source === 'synthetic'))
  assert.ok(model.dailyStatus.every((row) => row.source === 'synthetic'))
  assert.ok(model.offDays.every((row) => row.synthetic === 1))
})

test('ground-truth probabilities are real probabilities', () => {
  const model = generateModel(QUICK, 1)
  assert.ok(model.gtDaily.length > 0)
  assert.ok(model.gtDaily.every((row) => row.true_probability >= 0 && row.true_probability <= 1))
  assert.ok(model.gtDaily.every((row) => row.true_performed === 0 || row.true_performed === 1))
})

test('the estimate respects the cap and planning shrinks tasks to fit', () => {
  assert.ok(estimateRows(FULL) <= FULL.maxRows)
  const tight = { ...resolveConfig(), numTasks: 10, maxRows: 6000 }
  const plan = planGeneration(tight)
  assert.equal(plan.reducedTasks, true)
  assert.ok(plan.estimatedRows <= tight.maxRows)
  assert.ok(plan.config.numTasks < 10)
})

test('planning refuses to start when even the minimum cannot fit', () => {
  const impossible = { ...resolveConfig(), numTasks: 3, maxRows: 100 }
  assert.throws(() => planGeneration(impossible), /exceed the hard cap/)
})

test('an as-of export contains nothing from after the cutoff', () => {
  const model = generateModel(FULL, 1)
  const asOf = model.person.dates[120]
  const cutoff = asOfCutoff(asOf)
  const filtered = filterModelAsOf(model, asOf)
  assert.ok(filtered.sessions.every((row) => row.local_date <= asOf && row.created_at <= cutoff))
  assert.ok(filtered.checkins.every((row) => row.date <= asOf && row.created_at <= cutoff))
  assert.ok(filtered.dailyStatus.every((row) => row.local_date <= asOf && row.created_at <= cutoff))
  assert.ok(filtered.gtDaily.every((row) => row.date <= asOf))
  // Nothing is invented at the cutoff: there are strictly fewer rows than full.
  assert.ok(countRows(filtered) < countRows(model))
})

test('sessions fall inside their own local day', () => {
  const model = generateModel(QUICK, 1)
  assert.ok(
    model.sessions.every(
      (row) => row.started_at >= startOfLocalDay(row.local_date) && row.started_at <= endOfLocalDay(row.local_date),
    ),
  )
})

test('writing into a database without the synthetic marker is refused', () => {
  const db = openSyntheticDb(':memory:')
  try {
    const model = generateModel(QUICK, 1)
    db.exec('DROP TABLE synthetic_persons')
    assert.throws(() => writeModel(db, model), /synthetic marker/)
  } finally {
    db.close()
  }
})

test('a synthetic model can never be promoted', () => {
  const db = openSyntheticDb(':memory:')
  try {
    const model = registerSyntheticModel(db, 'candidate', { note: 'synthetic' })
    const decision = canPromoteModel(db, model.id)
    assert.equal(decision.ok, false)
    assert.match(decision.reason, /never be promoted/)
  } finally {
    db.close()
  }
})

test('the reloaded database reproduces the Phase 2a checks', () => {
  const db = openSyntheticDb(':memory:')
  try {
    const user = createSyntheticUser(db, {
      personId: QUICK.personId,
      label: QUICK.personLabel,
      kind: 'named',
      archetype: null,
      heldOut: false,
      seed: QUICK.seed,
    })
    const model = generateModel(QUICK, user.userId)
    writeModel(db, model)
    const checks = combineReports(QUICK.personId, QUICK.endDate, runPhase2aChecks(db, user.userId, QUICK))
    const failed = checks.checks.filter((row) => !row.ok)
    assert.equal(failed.length, 0, failed.map((row) => `${row.name}: ${row.detail}`).join('; '))
  } finally {
    db.close()
  }
})

test('the Phase 4 pipeline checks pass on the reloaded database', () => {
  const db = openSyntheticDb(':memory:')
  try {
    const user = createSyntheticUser(db, {
      personId: QUICK.personId,
      label: QUICK.personLabel,
      kind: 'named',
      archetype: null,
      heldOut: false,
      seed: QUICK.seed,
    })
    const model = generateModel(QUICK, user.userId)
    writeModel(db, model)
    // Off days travel as a layer file in Phase 3 and only reach the app's
    // `off_days` table on reload; insert them here so the check is exercised.
    for (const off of model.offDays) {
      db.prepare(
        `INSERT INTO off_days (user_id, kind, start_date, end_date, note, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'synthetic', ?, ?)`,
      ).run(
        user.userId,
        off.kind === 'personal' ? 'other' : off.kind,
        off.start_date,
        off.end_date,
        off.reason,
        Date.parse(off.start_date),
        Date.parse(off.start_date),
      )
    }
    // Score against the generator's own hidden ground truth, injected so the
    // test never depends on a file on disk. Still a pipeline check, not accuracy.
    const groundTruth: Phase4GroundTruth[] = model.gtDaily.map((row) => ({
      date: row.date,
      taskId: row.task_id,
      trueProbability: row.true_probability,
      truePerformed: row.true_performed,
      offDay: row.off_day,
    }))
    const checks = combineReports(
      QUICK.personId,
      QUICK.endDate,
      runPhase4Checks(db, user.userId, QUICK, { groundTruth }),
    )
    const failed = checks.checks.filter((row) => !row.ok)
    assert.equal(failed.length, 0, failed.map((row) => `${row.name}: ${row.detail}`).join('; '))
    // The Brier number is present and bounded; it is never an accuracy claim.
    const scored = checks.checks.find((row) => row.name.startsWith('predictions can be scored'))
    assert.ok(scored && /Brier 0\.\d+/.test(scored.detail))
  } finally {
    db.close()
  }
})

test('purge refuses any path other than the synthetic dataset', () => {
  assert.throws(() => purgeSyntheticData('server/data'), /Refusing to purge/)
})
