import test from 'node:test'
import assert from 'node:assert/strict'
import { assignToBot, buildAssignPlan } from '../desktop/plugin.js'

const STORAGE_KEY = 'botAssignmentHandoffs'
const clone = value => value === undefined ? undefined : structuredClone(value)

function fixture() {
  const data = new Map(), calls = [], writes = []
  const plan = buildAssignPlan({ bot: 'worker', kind: 'issue', repo: 'octocat/Hello-World', number: 42 })
  const key = JSON.stringify([plan.profile, plan.title])
  const state = { connection: 'windows', profile: 'owner', fail: null, failStage: '', switchOnCreate: false, switchOnOpen: false, openFailures: 0, coldRuntime: false }
  const storage = {
    get: (name, fallback) => clone(data.has(name) ? data.get(name) : fallback),
    set: (name, value) => {
      if (name === STORAGE_KEY && value?.[key]?.stage === state.failStage) throw new Error('storage unavailable')
      data.set(name, clone(value)); writes.push([name, clone(value)])
    },
  }
  const gateways = Object.fromEntries(['windows', 'linux'].map(connection => [connection, {
    request: async (method, params) => {
      calls.push({ connection, method, params: clone(params) })
      if (state.fail?.method === method) {
        const error = Object.assign(new Error(state.fail.message || 'RPC response unavailable'), state.fail.code === undefined ? {} : { code: state.fail.code })
        state.fail = null
        throw error
      }
      if (method === 'session.create') {
        if (state.switchOnCreate) state.connection = 'linux'
        return { session_id: 'runtime-42', stored_session_id: 'stored-42' }
      }
      if (method === 'session.resume') {
        assert.equal(params.session_id, 'stored-42', 'resume must refer to the existing durable session')
        return { session_id: 'resumed-42', stored_session_id: 'stored-42' }
      }
      if (method === 'prompt.submit' && state.coldRuntime && params.session_id === 'runtime-42') throw Object.assign(new Error('Session not found'), { code: 4001 })
      if (method === 'session.title' || method === 'prompt.submit') return { status: 'ok' }
      throw new Error(`Unexpected RPC ${method}`)
    },
  }]))
  const api = {
    state: { connectionId: { get: () => state.connection }, profile: { get: () => state.profile } },
    getGateway: () => gateways[state.connection],
    request: (...args) => gateways[state.connection].request(...args),
    openSession: async (id, options) => {
      calls.push({ method: 'open', id, options: clone(options) })
      if (state.switchOnOpen) state.connection = 'linux'
      if (state.openFailures > 0) { state.openFailures--; throw new Error('Lazy session is not visible yet') }
    },
  }
  return { api, plan, storage, data, state, calls, writes, key,
    record: () => data.get(STORAGE_KEY)?.[key],
    count: method => calls.filter(call => call.method === method).length,
    run: () => assignToBot(api, plan, { storage }),
  }
}

test('assignment persists ownership and completes once across repeated calls', async () => {
  const f = fixture()
  const result = await f.run()
  assert.deepEqual(result, { session_id: 'runtime-42', stored_session_id: 'stored-42', owner: { connection: 'windows', profile: 'owner' } })
  assert.equal(f.record()?.stage, 'complete')
  assert.deepEqual(f.record().plan, f.plan)
  assert.deepEqual(f.record().owner, { connection: 'windows', profile: 'owner' })
  assert.equal(f.record().session_id, result.session_id)
  assert.equal(f.record().stored_session_id, result.stored_session_id)
  const stages = f.writes.filter(([name]) => name === STORAGE_KEY).map(([, value]) => value[f.key].stage)
  for (const stage of ['creating', 'created', 'submitting', 'complete']) assert.ok(stages.includes(stage), `missing persisted ${stage}`)
  assert.deepEqual(await f.run(), result)
  assert.equal(f.count('session.create'), 1)
  assert.equal(f.count('prompt.submit'), 1)
  for (const call of f.calls.filter(call => call.method === 'open')) {
    assert.deepEqual(call.options.route, { connectionId: 'windows', profile: 'owner', targetProfile: 'worker' })
  }
})

test('assignment pins RPCs and session navigation when focus changes during creation or open', async () => {
  for (const trigger of ['switchOnCreate', 'switchOnOpen']) {
    const f = fixture(); f.state[trigger] = true
    await f.run()
    assert.equal(f.state.connection, 'linux')
    assert.ok(f.calls.filter(call => call.connection).every(call => call.connection === 'windows'))
    assert.equal(f.record().owner.connection, 'windows')
    assert.ok(f.calls.filter(call => call.method === 'open').every(call => call.options.route?.connectionId === 'windows'))
  }
})

test('lost session.create acknowledgment is retained and never automatically repeated', async () => {
  const f = fixture(); f.state.fail = { method: 'session.create' }
  await assert.rejects(f.run())
  assert.equal(f.record()?.stage, 'creating')
  await assert.rejects(f.run())
  assert.equal(f.count('session.create'), 1)
  assert.equal(f.count('prompt.submit'), 0)
})

test('lost prompt.submit acknowledgment cannot start a second turn after retry or module reload', async () => {
  const f = fixture(); f.state.fail = { method: 'prompt.submit' }
  await assert.rejects(f.run())
  assert.equal(f.record()?.stage, 'submitting')
  await assert.rejects(f.run())
  const reloaded = await import(`../desktop/plugin.js?assignment-recovery=${Date.now()}`)
  await assert.rejects(reloaded.assignToBot(f.api, f.plan, { storage: f.storage }))
  assert.equal(f.count('session.create'), 1)
  assert.equal(f.count('prompt.submit'), 1)
})

for (const code of [-32602, 4001, 4002, 4004, 4009, 4090, 4124]) {
  test(`definite prompt rejection ${code} retries the existing session only`, async () => {
    const f = fixture(); f.state.fail = { method: 'prompt.submit', code }
    await assert.rejects(f.run())
    assert.equal(f.record()?.stage, 'created')
    assert.equal(f.record().stored_session_id, 'stored-42')
    const result = await f.run()
    assert.equal(result.stored_session_id, 'stored-42')
    assert.equal(f.count('session.create'), 1)
    assert.equal(f.count('prompt.submit'), 2)
    assert.equal(f.record().stage, 'complete')
    const submissions = f.calls.filter(call => call.method === 'prompt.submit')
    assert.ok(submissions.every(call => ['runtime-42', 'resumed-42'].includes(call.params.session_id)))
    assert.ok(submissions.every(call => call.params.text === f.plan.prompt))
  })
}

test('storage failure before creating prevents all backend work', async () => {
  const f = fixture(); f.state.failStage = 'creating'
  await assert.rejects(f.run(), /storage unavailable/)
  assert.equal(f.calls.length, 0)
})

test('storage failure before submitting preserves a retryable created session', async () => {
  const f = fixture(); f.state.failStage = 'submitting'
  await assert.rejects(f.run(), /storage unavailable/)
  assert.equal(f.record()?.stage, 'created')
  assert.equal(f.count('prompt.submit'), 0)
  f.state.failStage = ''
  await f.run()
  assert.equal(f.count('session.create'), 1)
  assert.equal(f.count('prompt.submit'), 1)
})

test('failed completion persistence never causes a second accepted prompt', async () => {
  const f = fixture(); f.state.failStage = 'complete'
  await assert.rejects(f.run(), /storage unavailable/)
  assert.equal(f.record()?.stage, 'submitting')
  f.state.failStage = ''
  await assert.rejects(f.run())
  assert.equal(f.count('session.create'), 1)
  assert.equal(f.count('prompt.submit'), 1)
})

test('a lazy-session navigation miss retries opening without duplicating model work', async () => {
  const f = fixture(); f.state.openFailures = 1
  await f.run()
  assert.equal(f.record()?.stage, 'complete')
  await f.run()
  assert.equal(f.count('open'), 2)
  assert.equal(f.count('prompt.submit'), 1)
  assert.equal(f.record()?.stage, 'complete')
  assert.ok(f.calls.filter(call => call.method === 'open').every(call => call.id === 'stored-42'))
})

test('a cold created assignment resumes its durable session without creating another one', async () => {
  const f = fixture(); f.state.coldRuntime = true
  f.data.set(STORAGE_KEY, { [f.key]: { plan: f.plan, owner: { connection: 'windows', profile: 'owner' }, stage: 'created', session_id: 'runtime-42', stored_session_id: 'stored-42' } })
  let result
  try { result = await f.run() } catch (error) { assert.equal(error.code, 4001); result = await f.run() }
  assert.equal(result.session_id, 'resumed-42')
  assert.equal(result.stored_session_id, 'stored-42')
  assert.equal(f.count('session.create'), 0)
  assert.equal(f.count('session.resume'), 1)
  assert.equal(f.calls.filter(call => call.method === 'prompt.submit' && call.params.session_id === 'resumed-42').length, 1)
  assert.equal(f.record()?.stage, 'complete')
})

test('invalid persisted session identities stop before any RPC or navigation', async () => {
  for (const stage of ['created', 'complete']) {
    for (const field of ['session_id', 'stored_session_id']) {
      const f = fixture()
      f.data.set(STORAGE_KEY, { [f.key]: { plan: f.plan, owner: { connection: 'windows', profile: 'owner' }, stage, session_id: 'runtime-42', stored_session_id: 'stored-42', [field]: '' } })
      await assert.rejects(f.run())
      assert.equal(f.calls.length, 0)
    }
  }
})

test('same assignment cannot silently run again on another backend or owner profile', async () => {
  for (const change of [state => { state.connection = 'linux' }, state => { state.profile = 'other-owner' }]) {
    const f = fixture(); await f.run()
    const before = f.calls.length
    change(f.state)
    await assert.rejects(f.run())
    assert.equal(f.calls.length, before)
    assert.equal(f.count('session.create'), 1)
    assert.equal(f.count('prompt.submit'), 1)
  }
})

test('concurrent requests for one assignment never create duplicate sessions or turns', async () => {
  const f = fixture()
  const results = await Promise.allSettled([f.run(), f.run()])
  assert.ok(results.some(result => result.status === 'fulfilled'))
  assert.equal(f.count('session.create'), 1)
  assert.equal(f.count('prompt.submit'), 1)
  assert.equal(f.record()?.stage, 'complete')
})
