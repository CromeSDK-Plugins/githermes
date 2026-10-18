import test from 'node:test'
import assert from 'node:assert/strict'
import { metricFromReceipt, updateMetric, usageSnapshot, hermesCost, restoreMetrics, validatePrices, restorePrices, metricCost, metricDuration, aggregateMetrics, metricsCsv, filterMetrics } from '../desktop/plugin.js'

const receipt = () => ({ stored_session_id: 'stored', session_id: 'runtime', stage: 'complete', plan: { profile: 'worker', prompt: 'SECRET PROMPT', items: [{ repo: 'Example/Repo', number: 12, title: 'SECRET TITLE' }] }, modelReadback: { model: 'model', provider: 'provider', reasoning_effort: 'high', fast: false }, kickoff: 'SECRET RESPONSE' })
const base = () => metricFromReceipt(receipt(), 'issue', 'local', 'default')
const prices = () => validatePrices({ version: 1, rows: [{ model: 'model', provider: 'provider', date: '2026-10-15', input: 2, output: 8, cacheRead: 0.5, cacheWrite: 3 }] })
const measured = () => updateMetric(base(), { now: 100, control: { control: { goal: { status: 'active', created_at: 50 } } }, usage: { model: 'model', input: 1_000_000, output: 250_000, reasoning: 1000, cache_read: 200_000, cache_write: 100_000 } })

test('no provider-reporting evidence: absent and normalized zero buckets stay unknown', () => {
  const unknown = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null }
  assert.deepEqual(usageSnapshot(), unknown)
  assert.deepEqual(usageSnapshot({ input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0, calls: 0 }), unknown)
  assert.deepEqual(usageSnapshot({ input: -1, output: NaN, reasoning: Infinity, cache_read: '123', cache_write: 1.5 }), unknown)
  assert.deepEqual(usageSnapshot({ input: 22, output: 0 }), { ...unknown, input: 22 })
  assert.equal(metricCost(base(), prices()).label, 'nicht verfügbar')
})
test('legacy/nested and canonical shapes accept positive counters only', () => {
  const tokens = { input: 2, output: 3, reasoning: 1, cacheRead: 4, cacheWrite: 5 }
  assert.deepEqual(usageSnapshot({ usage: { input: 2, output: 3, reasoning: 1, cache_read: 4, cache_write: 5 } }), tokens)
  assert.deepEqual(usageSnapshot({ input_tokens: 2, output_tokens: 3, reasoning_tokens: 1, cache_read_tokens: 4, cache_write_tokens: 5 }), tokens)
})
test('cumulative snapshots replace, never sum; repeated ticks and counter reset are safe', () => {
  const first = measured()
  const duplicate = updateMetric(first, { usage: { input: 1_000_000, output: 250_000 }, now: 101 })
  assert.equal(duplicate.tokens.input, 1_000_000)
  const reset = updateMetric(duplicate, { usage: { input: 12, output: 2 }, now: 102 })
  assert.equal(reset.tokens.input, 12)
  assert.equal(updateMetric(reset, { usage: { input: 0, output: 0 } }).tokens.input, null)
  const known = updateMetric(duplicate, { usage: { input: 0, output: 2 }, now: 103 })
  const nullSnapshot = updateMetric(known, { usage: { input: null, output: null, reasoning: null, cache_read: null, cache_write: null }, now: 104 })
  assert.deepEqual(nullSnapshot.tokens, known.tokens)
  assert.equal(nullSnapshot.cost, known.cost)
  assert.equal(nullSnapshot.observedAt, known.observedAt)
})
test('native created_at is start; handoff complete is not done; observed done freezes final counters', () => {
  assert.equal(base().startedAt, null); assert.equal(base().endedAt, null)
  const row = measured()
  assert.equal(row.startedAt, 50); assert.equal(row.endedAt, null)
  assert.equal(metricDuration(row, 110), 60)
  const done = updateMetric(row, { usage: { input: 2_000_000, output: 500_000 }, control: { goal: { status: 'done', created_at: 50, updated_at: 99 } }, now: 120 })
  assert.equal(done.endedAt, 120); assert.equal(metricDuration(done, 999), 70)
  assert.deepEqual(updateMetric(done, { usage: { input: 99_000_000 }, now: 130 }), done)
  assert.equal(metricDuration(base(), 120), null)
  assert.equal(metricDuration(row, 1), null)
})
test('known price computes all buckets, with reasoning not added a second time', () => {
  const cost = metricCost(measured(), prices())
  assert.ok(Math.abs(cost.amount - 4.4) < 1e-12)
  assert.equal(cost.partial, false); assert.equal(cost.status, 'estimated'); assert.equal(cost.date, '2026-10-15')
})
test('Hermes cost wins; normalized zero is not a free run; explicit actual/included zero is valid', () => {
  assert.equal(hermesCost({ cost_usd: 0 }), null)
  assert.equal(hermesCost({ estimated_cost_usd: 0 }), null)
  assert.equal(hermesCost({ actual_cost_usd: 0 }), null)
  assert.equal(hermesCost({ actual_cost_usd: 0, cost_status: 'actual' }).status, 'actual')
  assert.equal(hermesCost({ cost_usd: 0, cost_status: 'included' }).status, 'included')
  const row = updateMetric(measured(), { usage: { cost_usd: 0.19, cost_status: 'actual' } })
  assert.equal(metricCost(row, { rows: [] }).amount, 0.19)
  assert.equal(metricCost(row, prices()).source, 'hermes')
  assert.equal(hermesCost({ actual_cost_usd: -2 }), null)
})
test('missing prices are not zero; absent cache buckets produce an explicit partial estimate', () => {
  assert.equal(metricCost(measured(), { rows: [] }).label, 'kein Preis hinterlegt')
  const incomplete = updateMetric(measured(), { usage: { input: 1_000_000, output: 250_000 } })
  assert.deepEqual(metricCost(incomplete, prices()), { amount: 4, status: 'estimated', source: 'table', date: '2026-10-15', partial: true })
  const table = prices(); table.rows[0].cacheWrite = null
  assert.equal(metricCost(measured(), table).label, 'kein Preis hinterlegt')
  const free = prices(); for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) free.rows[0][key] = 0
  assert.equal(metricCost(measured(), free).amount, 0)
})
test('provider-specific prices override model fallback; model switch blocks a single-rate estimate', () => {
  const table = prices(); table.rows.unshift({ ...table.rows[0], provider: '', input: 99 })
  assert.equal(metricCost(measured(), table).amount, 4.4)
  const switched = updateMetric(measured(), { usage: { model: 'other', input: 1_000_000, output: 100 } })
  assert.equal(switched.modelChanged, true); assert.equal(metricCost(switched, table).label, 'nicht verfügbar')
})
test('price validation preserves explicit zero/null and rejects bad dates, duplicates, and non-numeric rates', () => {
  for (const row of [{ date: '2026-02-30' }, { date: 'bad' }, { input: -1 }, { output: '1' }, { cacheRead: Infinity }]) assert.throws(() => validatePrices({ version: 1, rows: [{ ...prices().rows[0], ...row }] }))
  assert.throws(() => validatePrices({ version: 1, rows: [prices().rows[0], prices().rows[0]] }))
  assert.deepEqual(restorePrices({ wrong: true }), { version: 1, rows: [] })
})
test('persistence allowlists metadata, deduplicates identity, and restores known counters without contents', () => {
  const row = { ...measured(), prompt: 'SECRET PROMPT', response: 'SECRET RESPONSE', error: 'SECRET ERROR', tokens: { ...measured().tokens, raw: 'SECRET RAW' } }
  const clean = restoreMetrics([row, row])
  assert.equal(clean.length, 1); assert.equal(clean[0].tokens.input, row.tokens.input)
  assert.equal(clean[0].fast, false); assert.equal(clean[0].reasoning, 'high'); assert.equal(clean[0].ownerProfile, 'default')
  assert.ok(!JSON.stringify(clean).includes('SECRET'))
  assert.deepEqual(clean[0].items, [{ repo: 'example/repo', number: 12 }])
  assert.notEqual(metricFromReceipt(receipt(), 'issue', 'other').id, row.id)
})
test('UTC day/week/month aggregation uses latest cumulative goal totals and records unknown members', () => {
  const epoch = s => Date.parse(s) / 1000
  const a = { ...measured(), startedAt: epoch('2026-10-11T23:30:00Z'), endedAt: epoch('2026-10-11T23:31:00Z'), status: 'done' }
  const b = { ...measured(), id: 'other', profile: 'other', startedAt: epoch('2026-10-12T00:30:00Z'), endedAt: epoch('2026-10-12T00:32:00Z'), status: 'done' }
  const c = { ...base(), id: 'unknown', startedAt: a.startedAt, endedAt: a.endedAt, status: 'done' }
  const days = aggregateMetrics([a, b, c], 'day', prices())
  assert.equal(days.length, 2); assert.equal(days[0].key, '2026-10-12')
  assert.equal(days[1].tokens.input, 1_000_000); assert.equal(days[1].missing.input, 1)
  assert.equal(days[1].costMissing, 1); assert.equal(days[1].duration, 120)
  assert.deepEqual(aggregateMetrics([a, b], 'week', prices()).map(g => g.key), ['2026-10-12', '2026-10-05'])
  const months = aggregateMetrics([a, b], 'month', prices())
  assert.equal(months.length, 1); assert.equal(months[0].tokens.input, 2_000_000)
  assert.equal(aggregateMetrics([a, b], 'month', prices(), { profile: 'worker' })[0].goals, 1)
  assert.equal(filterMetrics([a, b], { model: 'missing' }).length, 0)
  assert.equal(aggregateMetrics([base()], 'month', prices())[0].cost, null)
})
test('CSV is filtered, escapes quotes/formulas, has blank unknowns and never includes prompts/replies', () => {
  const row = { ...measured(), model: '=FORMULA("x")', prompt: 'SECRET PROMPT', response: 'SECRET RESPONSE' }
  const csv = metricsCsv([row, { ...base(), profile: 'other' }], prices(), { profile: 'worker' }, 120)
  assert.equal(csv.split('\r\n').length, 3)
  assert.ok(csv.includes("'=FORMULA(")); assert.ok(csv.includes('""x""'))
  assert.ok(!csv.includes('SECRET')); assert.ok(csv.includes('end_observed_epoch'))
  assert.ok(metricsCsv([base()], prices()).includes('"nicht verfügbar"'))
})
