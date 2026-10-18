import test from 'node:test'
import assert from 'node:assert/strict'
import { createMetricsController, noteGoalReceipt } from '../desktop/plugin.js'
import { METRICS_KEY, metricFromReceipt } from '../desktop/plugin.js'
import * as plugin from '../desktop/plugin.js'
const receipt = (profile = 'worker', id = 'stored') => ({ stored_session_id: id, session_id: 'runtime', plan: { profile, prompt: 'SECRET PROMPT', items: [{ repo: 'example/repo', number: 12, title: 'SECRET TITLE' }] }, stage: 'complete', modelReadback: { model: 'm', provider: 'p', fast: false, reasoning_effort: 'high' } })
function fixture() {
  const data = new Map(), calls = [], flags = {}, snapshots = []
  let tick, clock = 200, focusedProfile = 'default'
  const storage = { get: (k, v) => data.get(k) ?? v, set: (k, v) => { if (flags.disk) throw Error('disk full'); data.set(k, structuredClone(v)) } }
  const request = async (method, params) => {
    calls.push([method, params]); if (flags[method]) throw Error('unavailable')
    if (method === 'session.active_list') return { sessions: flags.missing ? [] : [{ session_key: 'stored', id: 'runtime' }] }
    if (method === 'session.control.read') return { control: { goal: { status: flags.done ? 'done' : 'active', created_at: 100, title: 'SECRET GOAL', contract: { text: 'SECRET CONTRACT' } } } }
    if (method === 'session.usage') return flags.zero ? { input: 0, output: 0 } : { model: 'm', input: flags.input || 1000, output: 100, reasoning: 5, response: 'SECRET RESPONSE' }
    throw Error(method)
  }
  const gateway = { request }
  const api = { request, getGateway: () => gateway, state: { connectionId: { get: () => 'local' }, profile: { get: () => focusedProfile } } }
  const options = { now: () => clock, onChange: s => snapshots.push(structuredClone(s)), schedule: fn => { tick = fn; return 7 }, cancel: () => { tick = null } }
  const controller = createMetricsController(api, storage, options)
  return { api, storage, controller, data, calls, flags, snapshots, options, setClock: n => { clock = n }, focus: name => { focusedProfile = name }, tick: () => tick?.() }
}
test('collector polls only read methods, replaces snapshots, observes done and freezes after completion', async () => {
  const f = fixture(); f.controller.track(receipt(), 'issue')
  await f.controller.refresh(); await f.controller.refresh()
  assert.equal(f.controller.records[0].tokens.input, 1000)
  assert.equal(f.controller.records[0].endedAt, null)
  f.flags.input = 2000; f.flags.done = true; f.setClock(250)
  await f.controller.refresh()
  assert.equal(f.controller.records[0].tokens.input, 2000); assert.equal(f.controller.records[0].endedAt, 250)
  const count = f.calls.length; await f.controller.refresh(); assert.equal(f.calls.length, count)
  assert.ok(f.calls.every(([m]) => ['session.active_list', 'session.control.read', 'session.usage'].includes(m)))
  assert.ok(!JSON.stringify(f.data.get(METRICS_KEY)).includes('SECRET'))
  f.controller.dispose(); assert.equal(f.tick(), undefined)
})
test('unavailable usage still records native start and observed end without inventing tokens/costs', async () => {
  const f = fixture(); f.controller.track(receipt(), 'fix'); f.flags['session.usage'] = true; f.flags.done = true
  await f.controller.refresh()
  const row = f.controller.records[0]
  assert.equal(row.startedAt, 100); assert.equal(row.endedAt, 200)
  assert.equal(row.tokens.input, null); assert.equal(row.cost, null)
  assert.ok(f.snapshots.at(-1).error)
  f.controller.dispose()
})
test('normalized zeros remain unknown and no-live-session never triggers resume/create/prompt', async () => {
  const f = fixture(); f.controller.track(receipt(), 'pr'); f.flags.zero = true
  await f.controller.refresh(); assert.equal(f.controller.records[0].tokens.input, null)
  f.flags.missing = true; await f.controller.refresh()
  assert.equal(f.calls.at(-1)[0], 'session.active_list'); assert.ok(f.snapshots.at(-1).error)
  f.controller.dispose()
})
test('captured gateway is independent from a focus change; restart uses persisted owning route', async () => {
  const f = fixture(); f.controller.track(receipt(), 'issue'); f.focus('other')
  f.api.getGateway = () => ({ request: () => { throw Error('wrong gateway') } })
  await f.controller.refresh(); assert.equal(f.controller.records[0].tokens.input, 1000)
  f.controller.dispose()
  const routed = [], released = []
  f.api.requestProfile = async (route, method, params) => {
    assert.ok(route.connectionId.trim() && route.profile.trim() && route.targetProfile.trim(), 'current SDK route requires all three identities')
    routed.push(route); return f.api.request(method, params)
  }
  f.api.retainProfileSocket = route => () => released.push(route)
  const fresh = createMetricsController(f.api, f.storage, f.options)
  await fresh.refresh()
  assert.ok(routed.length); assert.ok(routed.every(r => r.profile === 'default' && r.connectionId === 'local' && r.targetProfile === 'worker'))
  fresh.dispose(); assert.equal(released.length, 1)
})
test('storage failure is surfaced, cannot overwrite last durable metric, and does not break handoff', async () => {
  const f = fixture(); f.controller.track(receipt(), 'issue')
  const stored = structuredClone(f.data.get(METRICS_KEY))
  f.flags.disk = true
  assert.doesNotThrow(() => noteGoalReceipt(f.storage, receipt(), 'issue', f.api))
  await f.controller.refresh()
  assert.deepEqual(f.data.get(METRICS_KEY), stored); assert.ok(f.snapshots.at(-1).error)
  f.controller.dispose()
})
test('null usage RPC response does not erase previously observed cumulative tokens', async () => {
  const f = fixture(); f.controller.track(receipt(), 'issue')
  await f.controller.refresh()
  const before = f.controller.records[0]
  f.api.getGateway = () => ({ request: async method => {
    if (method === 'session.active_list') return { sessions: [{ session_key: 'stored', id: 'runtime' }] }
    if (method === 'session.control.read') return { control: { goal: { status: 'active', created_at: 100 } } }
    if (method === 'session.usage') return { input: null, output: null, reasoning: null, cache_read: null, cache_write: null }
    throw Error(method)
  } })
  await f.controller.refresh()
  const after = f.controller.records[0]
  assert.deepEqual(after.tokens, before.tokens)
  assert.equal(after.cost, before.cost)
  f.controller.dispose()
})

test('reload deduplicates metadata-only records; a complete handoff is not a complete Goal', () => {
  const f = fixture(); noteGoalReceipt(f.storage, receipt(), 'pr', f.api); noteGoalReceipt(f.storage, receipt(), 'pr', f.api)
  assert.equal(f.controller.records.length, 1); assert.equal(f.controller.records[0].status, 'unknown')
  const clean = metricFromReceipt(receipt(), 'pr', 'local')
  assert.equal(clean.items.length, 1); assert.ok(!JSON.stringify(clean).includes('SECRET'))
  f.controller.dispose()
})
test('owning-gateway events capture final usage before done and reject replay/foreign session frames', () => {
  const f = fixture(); let listener, disposed = 0
  const gateway = { request: f.api.request, onEvent: fn => { listener = fn; return () => disposed++ } }
  f.api.getGateway = () => gateway
  f.controller.track(receipt(), 'issue'); f.controller.track(receipt(), 'issue')
  const event = (type, payload, seq, extra = {}) => listener({ type, payload, seq, session_id: 'runtime', ...extra })
  event('session.usage', { usage: { input: 100, output: 20 } }, 1)
  event('session.usage', { usage: { input: 999, output: 999 } }, 2, { session_id: 'foreign' })
  event('session.usage', { usage: { input: 99, output: 9 } }, 0)
  event('session.usage', { usage: { input: 999, output: 999 } }, 2, { replayed: true })
  assert.equal(f.controller.records[0].tokens.input, 100)
  event('message.complete', { usage: { input: 200, output: 40 }, text: 'SECRET RESPONSE' }, 3)
  assert.equal(f.controller.records[0].endedAt, null)
  event('session.control.update', { control: { goal: { status: 'done', created_at: 100 } } }, 4)
  event('session.usage', { usage: { input: 9999, output: 9999 } }, 5)
  assert.equal(f.controller.records[0].tokens.input, 200)
  assert.equal(f.controller.records[0].endedAt, 200)
  assert.ok(!JSON.stringify(f.data.get(METRICS_KEY)).includes('SECRET'))
  f.controller.dispose(); assert.equal(disposed, 1)
})
test('overlapping refresh calls coalesce and disposal prevents a late write', async () => {
  const f = fixture(); let release
  f.api.getGateway = () => ({ request: () => new Promise(resolve => { release = resolve }) })
  f.controller.track(receipt(), 'issue')
  const first = f.controller.refresh(), second = f.controller.refresh()
  assert.equal(first, second)
  const stored = structuredClone(f.data.get(METRICS_KEY))
  f.controller.dispose(); release({ sessions: [] }); await first
  assert.deepEqual(f.data.get(METRICS_KEY), stored)
})
test('real Issue/PR/Fix start hooks persist accounting metadata without additional model work', async () => {
  for (const kind of ['issue', 'pr', 'fix']) {
    const f = fixture()
    f.api.request = async (method, p) => {
      if (method === 'model.options') return { model: 'm', provider: 'p', providers: [{ slug: 'p', models: ['m'] }] }
      if (method === 'session.create') { f.focus('other'); return { session_id: 'runtime', stored_session_id: 'stored', info: { model: 'm', provider: 'p', reasoning_effort: 'high', fast: false } } }
      if (method === 'session.title' || method === 'prompt.submit') return {}
      if (method === 'session.control.read') return { control: { goal: prompt ? { title: prompt, status: 'active' } : null } }
      if (method === 'command.dispatch') return p.arg === 'show' ? { type: 'exec', output: `Goal (active): ${prompt}` } : (prompt = plugin.queueGoalObjective({ prompt: p.arg.slice(3) }), { type: 'send', message: prompt })
      throw Error(method)
    }
    let prompt
    const api = { ...f.api, getGateway: () => ({ request: f.api.request }), openSession: async () => {} }
    const empty = kind === 'issue' ? plugin.emptyGlobalIssueQueue : plugin.emptyGlobalPrQueue
    const update = kind === 'issue' ? plugin.updateGlobalIssueQueue : plugin.updateGlobalPrQueue
    const draft = update(empty(), { type: 'toggle', item: { repo: 'example/repo', number: 12, title: 'SECRET TITLE' } })
    const start = kind === 'issue' ? plugin.startIssueQueue : plugin.startPrQueue
    if (kind === 'fix') {
      const check = { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE', name: 'CI', id: 1 }
      const snapshot = { repo: 'example/repo', number: 12, state: 'open', head: 'a'.repeat(40), headRef: 'work', headRepo: 'example/repo', baseRef: 'main', fork: false, statusCheckRollup: [check], failed: [{ ...check, source: 'external', excerpt: 'SECRET LOG' }] }
      await plugin.startFixChecks(api, snapshot, {}, { storage: f.storage, profile: 'default', refresh: async () => snapshot })
    } else await start(api, draft, { storage: f.storage })
    const rows = f.data.get(METRICS_KEY)
    assert.equal(rows.length, 1); assert.equal(rows[0].kind, kind); assert.equal(rows[0].fast, false)
    assert.equal(rows[0].ownerProfile, 'default') // focus changed during create; owner did not
    assert.equal(rows[0].endedAt, null); assert.ok(!JSON.stringify(rows).includes('SECRET'))
    f.controller.dispose()
  }
})
