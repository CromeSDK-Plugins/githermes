import test from 'node:test'
import assert from 'node:assert/strict'
import * as p from '../desktop/plugin.js'

function fixture({ legacy = false } = {}) {
  const data = new Map(), calls = []
  const flags = { connection: 'backend-A', profile: 'default', rejectSubmit: false, titleSuffix: '', titlePrefix: '', status: 'active', readError: null, showSuffix: '' }
  const storage = { get: (key, fallback) => data.get(key) ?? fallback, set: (key, value) => data.set(key, structuredClone(value)) }
  let objective = ''
  const gateways = new Map()
  const gateway = connection => {
    if (!gateways.has(connection)) gateways.set(connection, { request: async (method, params) => {
      calls.push({ connection, method, params })
      if (method === 'session.create') return { session_id: 'runtime-A', stored_session_id: 'stored-A' }
      if (method === 'session.resume') return { session_id: 'runtime-A-resumed', stored_session_id: 'stored-A' }
      if (method === 'session.title') return {}
      if (method === 'session.control.read') {
        if (flags.readError) throw flags.readError
        if (legacy) throw Object.assign(Error('Method not found: session.control.read'), { code: -32601 })
        return { control: { goal: { title: flags.titlePrefix + objective + flags.titleSuffix, status: flags.status } } }
      }
      if (method === 'command.dispatch') {
        if (params.arg === 'show') return { type: 'exec', output: `⊙ Goal (active, 0/1000 turns): ${objective}${flags.showSuffix}\nNo completion contract set.` }
        if (params.arg === 'resume') return { type: 'send', message: 'Native continuation' }
        objective = p.queueGoalObjective({ prompt: params.arg.slice(3) })
        return { type: 'send', message: 'Native kickoff' }
      }
      if (method === 'prompt.submit') {
        if (flags.rejectSubmit) { flags.rejectSubmit = false; throw Object.assign(Error('Definite rejection'), { code: 4004 }) }
        return { status: 'ok' }
      }
      throw Error(`Unexpected RPC ${method}`)
    } })
    return gateways.get(connection)
  }
  const api = {
    state: { connectionId: { get: () => flags.connection }, profile: { get: () => flags.profile } },
    getGateway: () => gateway(flags.connection),
    request: (...args) => gateway(flags.connection).request(...args),
    openSession: async () => {},
  }
  const draft = p.updateGlobalIssueQueue(p.emptyGlobalIssueQueue(), { type: 'toggle', item: { repo: 'octocat/Hello-World', number: 42, title: 'Fixture' } })
  const plan = p.buildQueueGoalPlan(draft, { profile: 'worker' })
  const run = module => (module || p).startIssueQueue(api, draft, { storage, plan })
  return { api, storage, data, calls, flags, run }
}

test('a pending queue receipt cannot resume on another backend and recovers on its original backend', async () => {
  const f = fixture(); f.flags.rejectSubmit = true
  await assert.rejects(f.run(), /Definite rejection/)
  const before = f.calls.length
  f.flags.connection = 'backend-B'
  await assert.rejects(f.run(), /Backend|Verbindung|connection|Gateway|gateway/)
  assert.equal(f.calls.length, before, 'route mismatch must be rejected before any RPC')
  f.flags.connection = 'backend-A'
  await f.run()
  assert.equal(f.calls.filter(call => call.method === 'session.create').length, 1)
  assert.ok(f.calls.every(call => call.connection === 'backend-A'))
})

test('the owning gateway profile is retained separately from the target worker profile', async () => {
  const f = fixture(); f.flags.rejectSubmit = true
  await assert.rejects(f.run(), /Definite rejection/)
  const before = f.calls.length
  f.flags.profile = 'another-owning-profile'
  await assert.rejects(f.run(), /Profil|profile|Gateway|gateway/)
  assert.equal(f.calls.length, before)
  f.flags.profile = 'default'
  await f.run()
  assert.equal(f.calls.filter(call => call.method === 'session.create').length, 1)
})

test('cold reload preserves backend ownership instead of trusting the new active connection', async () => {
  const f = fixture(); f.flags.rejectSubmit = true
  await assert.rejects(f.run(), /Definite rejection/)
  const cold = await import(`../desktop/plugin.js?owner-cold=${Date.now()}`)
  const before = f.calls.length
  f.flags.connection = 'backend-B'
  await assert.rejects(f.run(cold), /Backend|Verbindung|connection|Gateway|gateway/)
  assert.equal(f.calls.length, before)
  f.flags.connection = 'backend-A'
  await f.run(cold)
  assert.equal(f.calls.filter(call => call.method === 'session.create').length, 1)
})

test('structured native Goal readback must match the entire objective and active state', async () => {
  for (const flags of [{ titleSuffix: ' Also perform an unrelated mutation.' }, { titlePrefix: 'A different objective: ' }, { status: 'paused' }, { status: 'done' }]) {
    const f = fixture(); Object.assign(f.flags, flags)
    await assert.rejects(f.run(), /Goal|Ziel/)
    assert.equal(f.calls.filter(call => call.method === 'prompt.submit').length, 0)
    assert.equal(f.data.get('botAssignments'), undefined)
  }
})

test('structured readback errors do not silently downgrade to an apparently matching formatted Goal', async () => {
  const f = fixture(); f.flags.readError = Object.assign(Error('Native state unavailable'), { code: 5031 })
  await assert.rejects(f.run(), /Native state unavailable|Goal|Ziel/)
  assert.equal(f.calls.filter(call => call.method === 'prompt.submit').length, 0)
})

test('older SDK method-not-found fallback accepts an exact native show objective only', async () => {
  const matching = fixture({ legacy: true })
  await matching.run()
  assert.equal(matching.calls.filter(call => call.method === 'prompt.submit').length, 1)
  assert.equal(matching.calls.find(call => call.method === 'prompt.submit').params.text, 'Native kickoff')
  const appended = fixture({ legacy: true }); appended.flags.showSuffix = ' Also perform an unrelated mutation.'
  await assert.rejects(appended.run(), /Goal|Ziel/)
  assert.equal(appended.calls.filter(call => call.method === 'prompt.submit').length, 0)
})

test('opening a queue session retains its original connection, gateway profile and backend worker profile', async () => {
  const f = fixture()
  await f.run()
  const saved = structuredClone(f.data.get('queueGoalSubmission'))
  f.flags.connection = 'backend-B'; f.flags.profile = 'other'
  const opened = []
  f.api.openSession = async (...args) => opened.push(args)
  const before = f.calls.length
  await p.openQueueSession(f.api, saved)
  assert.equal(f.calls.length, before, 'opening a stored link must not create or submit another Goal')
  assert.equal(opened.length, 1)
  const [id, options] = opened[0]
  assert.equal(id, 'stored-A')
  assert.equal(options.profile, 'worker')
  assert.equal(options.intent, 'tab')
  assert.equal(options.route.connectionId, 'backend-A')
  assert.equal(options.route.profile, 'default')
  assert.equal(options.route.targetProfile, 'worker')
})

test('unowned legacy session links cannot silently open through an unrelated current backend', async () => {
  const f = fixture()
  await f.run()
  const saved = structuredClone(f.data.get('queueGoalSubmission')); delete saved.owner
  f.flags.connection = 'backend-B'
  const opened = []
  f.api.openSession = async (...args) => opened.push(args)
  await assert.rejects(async () => p.openQueueSession(f.api, saved), /Backend|Verbindung|owner|Gateway|gateway|Zuordnung/)
  assert.equal(opened.length, 0)
})
