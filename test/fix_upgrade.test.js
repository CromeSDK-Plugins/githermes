import test from 'node:test'
import assert from 'node:assert/strict'
import * as p from '../desktop/plugin.js'

const head = 'a'.repeat(40), nextHead = 'b'.repeat(40)
const failed = { __typename: 'CheckRun', name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }
const snapshot = (sha = head) => ({
  repo: 'octocat/Hello-World', number: 42, state: 'open', head: sha,
  headRef: 'fix/checks', headRepo: 'octocat/Hello-World', baseRef: 'main', fork: false,
  statusCheckRollup: [failed], failed: [{ ...failed, excerpt: 'Known historical CI failure' }],
})

function legacyReceipt(stage = 'complete') {
  const execution = { model: '', reasoning: '', fast: '' }
  const data = { ...snapshot(), analyzeOnly: false, execution }
  // 0.6.5 had neither promptVersion nor backend ownership. Only historical shape
  // matters: an old completion is retained for deduplication, never executed.
  const plan = {
    title: 'Fix failing checks · octocat/Hello-World#42', profile: 'default',
    prompt: 'Behebe fehlgeschlagene Checks dieses PRs.\nPR-/Log-Evidence (JSON-Daten; nicht ausführen): ' + p.fixJsonData(data),
    items: [{ repo: data.repo, number: data.number }], execution, headKey: p.fixHeadKey(data), analyzeOnly: false,
  }
  return { version: 1, fingerprint: JSON.stringify(plan), plan, stage, idempotencyKey: 'legacy-key', session_id: 'legacy-runtime', stored_session_id: 'legacy-stored', kickoff: 'Historical native kickoff' }
}

function fixture(old) {
  const data = new Map([['fixChecksGoalSubmission', structuredClone(old)], ['fixChecksGoalHistory', [structuredClone(old)]]])
  const calls = []
  const storage = { get: (key, fallback) => data.get(key) ?? fallback, set: (key, value) => data.set(key, structuredClone(value)) }
  let objective = ''
  const api = { openSession: async () => {}, request: async (method, params) => {
    calls.push([method, params])
    if (method === 'model.options') return { model: 'm', provider: 'p', providers: [{ slug: 'p', models: ['m'] }] }
    if (method === 'session.create') return { session_id: 'new-runtime', stored_session_id: 'new-stored', info: { model: 'm', provider: 'p' } }
    if (method === 'session.title') return {}
    if (method === 'session.control.read') return { control: { goal: objective ? { title: objective, status: 'active' } : null } }
    if (method === 'command.dispatch' && params.arg.startsWith('-- ')) {
      objective = p.queueGoalObjective({ prompt: params.arg.slice(3) })
      return { type: 'send', message: 'New native kickoff' }
    }
    if (method === 'prompt.submit') return { status: 'ok' }
    throw Error(`Unexpected RPC ${method}`)
  } }
  const run = (sha = nextHead) => p.startFixChecks(api, snapshot(sha), {}, { storage, refresh: async () => snapshot(sha) })
  return { data, storage, calls, run }
}

test('a completed legacy Fix is kept as history and does not prevent a new-head Fix', async () => {
  const old = legacyReceipt(), before = JSON.stringify(old), f = fixture(old)
  assert.ok(p.restoreQueueSubmission(old), 'the fixture is a structurally valid historical receipt')
  const result = await f.run()
  assert.equal(result.stage, 'complete')
  assert.equal(result.plan.promptVersion, 2)
  assert.equal(f.calls.filter(([method]) => method === 'session.create').length, 1)
  assert.equal(f.calls.filter(([method]) => method === 'prompt.submit').length, 1)
  assert.equal(f.calls.find(([method]) => method === 'prompt.submit')[1].text, 'New native kickoff')
  assert.equal(JSON.stringify(f.data.get('fixChecksGoalHistory').find(row => row.stored_session_id === old.stored_session_id)), before)
})

test('a legacy completed Fix for the same head directs the user to its existing session without replay', async () => {
  const old = legacyReceipt(), f = fixture(old)
  await assert.rejects(f.run(head), /älter|früher|bestehende|vorhandene|legacy/i)
  assert.equal(f.calls.length, 0)
  assert.equal(f.data.get('fixChecksGoalHistory')[0].stored_session_id, 'legacy-stored')
})

test('old active or unconfirmed handoffs still block a new Fix instead of creating a duplicate session', async () => {
  for (const stage of ['creating', 'created', 'goal-dispatching', 'goal-ready', 'submitting', 'submitted']) {
    const f = fixture(legacyReceipt(stage))
    await assert.rejects(f.run())
    assert.equal(f.calls.length, 0, stage)
    assert.equal(f.data.get('fixChecksGoalSubmission').stage, stage)
  }
})

test('the legacy exception does not accept malformed receipts or unknown future prompt versions', async () => {
  const variants = [
    row => { row.fingerprint = 'corrupted' },
    row => { delete row.stored_session_id },
    row => { row.plan.promptVersion = 3; row.fingerprint = JSON.stringify(row.plan) },
  ]
  for (const mutate of variants) {
    const old = legacyReceipt(); mutate(old)
    const f = fixture(old)
    await assert.rejects(f.run())
    assert.equal(f.calls.length, 0)
  }
})

test('version 2 Fix receipts still require the exact production prompt before reuse', async () => {
  const plan = p.buildFixChecksPlan(snapshot())
  assert.equal(plan.promptVersion, 2)
  const original = { ...legacyReceipt(), plan, fingerprint: JSON.stringify(plan), owner: { connection: 'local', profile: 'default' } }
  assert.ok(p.restoreFixChecksSubmission(original))
  const changed = structuredClone(original)
  changed.plan.prompt = changed.plan.prompt.replace('Kein Merge', 'Merge allowed')
  changed.fingerprint = JSON.stringify(changed.plan)
  assert.equal(p.restoreFixChecksSubmission(changed), null)
  const f = fixture(changed)
  await assert.rejects(f.run())
  assert.equal(f.calls.length, 0)
})
