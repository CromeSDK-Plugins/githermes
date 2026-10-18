import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import plugin, { TOKEN_KEYS, metricFromReceipt, updateMetric } from '../desktop/plugin.js'

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const quoted = key => [...source.matchAll(new RegExp(`'${key}'`, 'g'))].length

test('TOKEN_KEYS and hasTokenObservation share one field table', () => {
  const tableStart = source.indexOf('export const TOKEN_FIELDS = [')
  const keysLine = source.indexOf('export const TOKEN_KEYS = TOKEN_FIELDS.map(([key]) => key)')
  assert.ok(tableStart !== -1 && keysLine > tableStart, 'TOKEN_KEYS must be derived from TOKEN_FIELDS')
  const table = source.slice(tableStart, keysLine)
  assert.deepEqual([...table.matchAll(/'([^']+)'/g)].map(match => match[1]), [
    'input', 'input', 'input_tokens',
    'output', 'output', 'output_tokens',
    'reasoning', 'reasoning', 'reasoning_tokens',
    'cacheRead', 'cache_read', 'cache_read_tokens',
    'cacheWrite', 'cache_write', 'cache_write_tokens',
  ])
  const update = source.slice(source.indexOf('export function updateMetric'), source.indexOf('export function restoreMetrics'))
  assert.equal(update.includes('input_tokens'), false, 'updateMetric still has its own raw-key list')
  assert.match(update, /RAW_TOKEN_KEYS\.some\(/)
  for (const alias of ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    assert.equal(quoted(alias), 1, `${alias} is still listed more than once`)
  }
  assert.deepEqual(TOKEN_KEYS, ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'])
})

test('explicit numeric values on every raw alias remain observations', () => {
  const receipt = { stored_session_id: 'stored', session_id: 'runtime', stage: 'complete', plan: { profile: 'worker', items: [{ repo: 'Example/Repo', number: 12 }] }, modelReadback: { model: 'model', provider: 'provider' } }
  const known = updateMetric(metricFromReceipt(receipt, 'issue'), { usage: { input: 10, output: 4 }, now: 10 })
  for (const key of ['input', 'input_tokens', 'output', 'output_tokens', 'reasoning', 'reasoning_tokens', 'cache_read', 'cache_read_tokens', 'cache_write', 'cache_write_tokens']) {
    assert.equal(updateMetric(known, { usage: { [key]: 0 }, now: 11 }).observedAt, 11, key)
  }
  const kept = updateMetric(known, { usage: { input: null, output: null, reasoning: null, cache_read: null, cache_write: null, input_tokens: null }, now: 12 })
  assert.equal(kept.observedAt, known.observedAt)
  assert.equal(kept.tokens.input, 10)
})

function load(extra = {}) {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
  const contributions = []
  const disposers = []
  const storage = new Map([['repo', 'SECRET-OWNER/private-project']])
  plugin.register({
    register: contribution => { contributions.push(contribution); return () => {} },
    onDispose: fn => disposers.push(fn),
    storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, value) => storage.set(key, value) },
    ...extra,
  })
  return { contributions, dispose: () => disposers.splice(0).forEach(fn => fn()) }
}

test('missing registerSettingsPage warns once, continues registration, and stays quiet when the API exists', () => {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  const loaded = []
  try {
    loaded.push(load())
    loaded.push(load())
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /registerSettingsPage/)
    assert.doesNotMatch(warnings[0], /SECRET-OWNER|private-project|worker|token|ghp_|github_pat_/)
    assert.ok(loaded[0].contributions.some(entry => entry.id === 'palette-goal-metrics'))
    assert.ok(loaded[1].contributions.some(entry => entry.id === 'palette-goal-metrics'))

    const pages = []
    warnings.length = 0
    loaded.push(load({ registerSettingsPage: page => pages.push(page) }))
    assert.equal(warnings.length, 0)
    assert.equal(pages.length, 1)
    assert.equal(pages[0].id, 'goal-metrics')
    assert.equal(pages[0].title, 'GitHermes')
    assert.equal(typeof pages[0].render, 'function')
  } finally {
    console.warn = original
    for (const entry of loaded) entry.dispose()
  }
})
