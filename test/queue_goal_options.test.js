import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../desktop/plugin.js'

const selected = () => [['octocat/Hello-World', 42], ['github/sdk', 42], ['OCTOCAT/Hello-World', 27], ['github/sdk', 26]].reduce((d, [repo, number]) => plugin.updateGlobalIssueQueue(d, { type: 'toggle', item: { repo, number, title: `Issue ${number}`, state: 'OPEN' } }), plugin.emptyGlobalIssueQueue())
const options = (draft, values) => plugin.updateGlobalIssueQueue(draft, { type: 'options', options: values })
const defaults = { model: '', reasoning: '', fast: '', profile: '', strategy: 'squash', autoMerge: false, repositoryExecution: 'sequential', refinementAllowed: false, blockOnIssue: true }

test('new Goal options have safe defaults and migrate old global and per-repo drafts without consent', () => {
 assert.deepEqual(plugin.emptyGlobalIssueQueue().options, defaults)
 const draft = selected(), old = { ...draft, options: { profile: 'worker', strategy: 'rebase', autoMerge: true } }, before = JSON.stringify(old)
 const restored = plugin.restoreGlobalIssueQueue(old)
 assert.deepEqual(restored.items, draft.items)
 assert.deepEqual(restored.options, { ...defaults, profile: 'worker', strategy: 'rebase' })
 assert.equal(JSON.stringify(old), before)
 assert.match(plugin.buildQueueGoalPlan(old).prompt, /Issue-Body nicht verändern/)
 const legacy = { 'github/sdk': plugin.updateIssueQueue(plugin.emptyIssueQueue('github/sdk'), { type: 'toggle', item: { number: 42, title: 'Old issue', state: 'OPEN' } }) }
 assert.deepEqual(plugin.restoreGlobalIssueQueue(null, legacy).options, defaults)
 assert.deepEqual(plugin.updateGlobalIssueQueue(options(draft, { refinementAllowed: true, autoMerge: true }), { type: 'clear' }).options, defaults)
})

test('invalid enum and boolean options fail at edit, restore and executable-plan boundaries', () => {
 const draft = selected(), before = JSON.stringify(draft)
 for (const value of ['simultaneous', '', null, true, 1, undefined]) {
  const bad = { repositoryExecution: value }
  assert.throws(() => options(draft, bad), /Ungültige Queue-Optionen/)
  assert.ok(plugin.restoreGlobalIssueQueue({ ...draft, options: { ...draft.options, ...bad } }).notice)
  assert.throws(() => plugin.buildQueueGoalPlan({ ...draft, options: { ...draft.options, ...bad } }), /Ungültige Queue/)
 }
 for (const key of ['refinementAllowed', 'blockOnIssue', 'autoMerge']) for (const value of ['true', 0, 1, null, undefined, {}, []]) {
  const bad = { [key]: value }
  assert.throws(() => options(draft, bad), /Ungültige Queue-Optionen/)
  assert.ok(plugin.restoreGlobalIssueQueue({ ...draft, options: { ...draft.options, ...bad } }).notice)
  assert.throws(() => plugin.buildQueueGoalPlan({ ...draft, options: { ...draft.options, ...bad } }), /Ungültige Queue/)
 }
 assert.throws(() => options(draft, { parallel: true }), /Ungültige Queue-Optionen/)
 assert.equal(JSON.stringify(draft), before)
})

test('global order is retained and parallelism is confined to independent repositories', () => {
 const draft=selected(), sequential=plugin.buildQueueGoalPlan(draft), parallel=plugin.buildQueueGoalPlan(options(draft,{repositoryExecution:'parallel'}))
 assert.deepEqual(parallel.items,sequential.items)
 assert.deepEqual(parallel.prompt.split('\n').filter(s=>/^\d+\./.test(s)),sequential.prompt.split('\n').filter(s=>/^\d+\./.test(s)))
 assert.match(sequential.prompt,/nacheinander in globaler Auswahlreihenfolge/)
 assert.match(parallel.prompt,/Unabhängige Repositories dürfen parallel/)
 assert.match(parallel.prompt,/getrennten Checkouts\/Worktrees/)
 assert.match(parallel.prompt,/innerhalb jedes Repositories Auswahlreihenfolge/)
 assert.match(parallel.prompt,/Abhängigkeiten vorab prüfen/)
 assert.equal(parallel.cwd,undefined)
})

test('all workflow combinations retain refinement, blocker scope and merge boundaries', () => {
 for(const repositoryExecution of ['sequential','parallel']) for(const refinementAllowed of [false,true]) for(const blockOnIssue of [false,true]) for(const autoMerge of [false,true]) {
  const prompt=plugin.buildQueueGoalPlan(options(selected(),{repositoryExecution,refinementAllowed,blockOnIssue,autoMerge})).prompt
  assert.match(prompt,refinementAllowed?/Issue-Klärung erlaubt/:/Issue-Body nicht verändern/)
  if(refinementAllowed) for(const text of ['aktuellen Body lesen','konkurrierende Änderungen erhalten','Ergebnis zurücklesen','ohne den fachlichen Umfang zu erweitern']) assert.ok(prompt.includes(text),text)
  assert.match(prompt,blockOnIssue?/echten Blocker die Queue pausieren/:/echten Blocker nur das betroffene Repository pausieren/)
  if(!blockOnIssue) for(const text of ['im parallelen Modus','Im sequenziellen Modus','Keine abhängigen oder späteren Issues']) assert.ok(prompt.includes(text),text)
  assert.match(prompt,autoMerge?/Merge ist für die ausgewählten Issues vorab erlaubt/:/Nicht mergen und kein Auto-Merge aktivieren/)
  assert.match(prompt,/keine Sammel-PRs oder zusätzlichen Aufgaben/)
  assert.match(prompt,/Keine GitHub-Assignees nach lokalen Profilnamen ändern/)
 }
})

test('real disk reload preserves explicit new preferences, resets merge consent and retains all items', async () => {
 const root = fileURLToPath(new URL('../../../artifacts/githermes-goal-prompt-options/', import.meta.url))
 mkdirSync(root, { recursive: true }); const dir = mkdtempSync(join(root, 'storage-'))
 try {
  const file = join(dir, 'storage.json'), draft = options(selected(), { repositoryExecution: 'parallel', refinementAllowed: true, blockOnIssue: false, autoMerge: true })
  const storage = { set: (key, value) => writeFileSync(file, JSON.stringify({ [key]: value })) }
  plugin.persistGlobalIssueQueue(storage, draft)
  const cold = await import(`../desktop/plugin.js?options-cold=${Date.now()}`)
  const restored = cold.restoreGlobalIssueQueue(JSON.parse(readFileSync(file)).globalIssueQueue)
  assert.deepEqual(restored.items, draft.items)
  assert.deepEqual(restored.options, { ...draft.options, autoMerge: false })
  assert.match(cold.buildQueueGoalPlan(restored).prompt, /Nicht mergen/)
  assert.throws(() => plugin.persistGlobalIssueQueue({ set: () => { throw new Error('disk full') } }, options(draft, { refinementAllowed: false })), /disk full/)
  assert.deepEqual(JSON.parse(readFileSync(file)).globalIssueQueue, draft)
 } finally { rmSync(dir, { recursive: true, force: true }) }
})

function transportFixture() {
 const data = new Map(), calls = []; let objective = ''
 const storage = { get: (key, fallback) => data.get(key) ?? fallback, set: (key, value) => data.set(key, structuredClone(value)) }
 const request = async (method, params) => {
  calls.push([method, params])
  if (method === 'session.create') return { session_id: 'runtime', stored_session_id: `stored-${calls.length}` }
  if (method === 'session.title') return {}
  if (method === 'session.control.read') return { control: { goal: objective ? { title: objective, status: 'active' } : null } }
  if (method === 'command.dispatch' && params.arg.startsWith('-- ')) { objective = plugin.queueGoalObjective({ prompt: params.arg.slice(3) }); return { type: 'send', message: objective } }
  if (method === 'command.dispatch' && params.arg === 'show') return { type: 'exec', output: `Goal (active): ${objective}` }
  if (method === 'prompt.submit') return { status: 'ok' }
  throw new Error(`Unexpected RPC ${method}`)
 }
 return { data, calls, storage, api: { request, openSession: async () => {} } }
}

test('every option change alters the durable fingerprint and submits exactly the preview plan', async () => {
 const base = selected(), plans = [base, ...[{ repositoryExecution: 'parallel' }, { refinementAllowed: true }, { blockOnIssue: false }, { autoMerge: true }].map(values => options(base, values))].map(draft => ({ draft, plan: plugin.buildQueueGoalPlan(draft) }))
 assert.equal(new Set(plans.map(({ plan }) => JSON.stringify(plan))).size, plans.length)
 const f = transportFixture()
 for (const { draft, plan } of plans) {
  const receipt = await plugin.startIssueQueue(f.api, draft, { storage: f.storage, plan })
  assert.equal(receipt.fingerprint, JSON.stringify(plan))
  assert.deepEqual(f.data.get('queueGoalSubmission').plan, plan)
  assert.equal(f.calls.filter(([m, p]) => m === 'command.dispatch' && p.arg.startsWith('-- ')).at(-1)[1].arg, `-- ${plan.prompt}`)
  assert.equal(f.calls.filter(([m]) => m === 'prompt.submit').at(-1)[1].text, plugin.queueGoalObjective(plan))
  assert.equal(receipt.stage, 'complete')
 }
 assert.equal(f.calls.filter(([method]) => method === 'session.create').length, plans.length)
 assert.ok(f.calls.every(([method]) => ['session.create', 'session.title', 'command.dispatch', 'session.control.read', 'prompt.submit'].includes(method)))
})

test('changed prompt policy cannot replace an unfinished Goal receipt or create a second session', async () => {
 const draft = selected(), f = transportFixture()
 const request = f.api.request
 f.api.request = async (method, params) => { if (method === 'prompt.submit') throw Object.assign(new Error('definite rejection'), { code: 4004 }); return request(method, params) }
 await assert.rejects(plugin.startIssueQueue(f.api, draft, { storage: f.storage }), /definite rejection/)
 for (const value of [{ repositoryExecution: 'parallel' }, { refinementAllowed: true }, { blockOnIssue: false }]) await assert.rejects(plugin.startIssueQueue(f.api, options(draft, value), { storage: f.storage }), /Vorheriger Goal-Start ist unvollständig/)
 assert.equal(f.calls.filter(([method]) => method === 'session.create').length, 1)
})
