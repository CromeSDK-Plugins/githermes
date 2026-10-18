import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as p from '../desktop/plugin.js'

const item = (repo, number) => ({ repo, number, title: `Selected ${number}`, state: 'OPEN' })
const selected = () => [item('octocat/Hello-World', 42), item('github/sdk', 27)].reduce((draft, value) => p.updateGlobalIssueQueue(draft, { type: 'toggle', item: value }), p.emptyGlobalIssueQueue())
const options = values => p.updateGlobalIssueQueue(selected(), { type: 'options', options: values })
const plan = values => p.buildQueueGoalPlan(options(values))
const prDraft = values => p.updateGlobalPrQueue([item('octocat/Hello-World', 42), item('github/sdk', 27)].reduce((draft, value) => p.updateGlobalPrQueue(draft, { type: 'toggle', item: value }), p.emptyGlobalPrQueue()), { type: 'options', options: values })

const evidence = prompt => {
 for (const text of ['notwendigen fachlichen Entscheidung', 'fehlendem Zugriff', 'nicht selbst lösbaren Hindernis', 'Befund', 'versuchte Abhilfe', 'benötigte Entscheidung', 'Bereits erteilte Erlaubnisse gelten weiter']) assert.ok(prompt.includes(text), text)
}

test('new issue and PR work repairs normal failures without a pause-or-skip policy', () => {
 for (const prompt of [plan({}).prompt, p.buildPrQueueGoalPlan(prDraft({})).prompt]) {
  assert.match(prompt, /Patch-, Tool-, Build- und Testfehler selbst diagnostizieren/)
  assert.match(prompt, /git status, git diff und betroffene Abschnitte frisch lesen/)
  assert.match(prompt, /bereits erfolgreiche Änderungen erhalten/)
  assert.match(prompt, /kleine Änderungen mit eindeutigem Kontext/)
  assert.match(prompt, /tatsächlichen Dateistand prüfen/)
  assert.match(prompt, /keine Nutzerfreigabe/)
  assert.match(prompt, /keine blinde Schleife/)
  assert.doesNotMatch(prompt, /Pause-on-error|Fehlerbehandlung \(Stop\)|vor weiteren Änderungen oder erneuten Testläufen stoppen/)
  evidence(prompt)
 }
})

test('legacy Stop and Skip drafts migrate without losing items, options or granting merge consent', () => {
 for (const onError of ['stop','skip']) for (const kind of ['issue','pr']) {
  const original = kind === 'issue' ? options({autoMerge:true,refinementAllowed:true}) : prDraft({conflicts:'rebase-fix'})
  original.options.onError=onError
  const before=JSON.stringify(original)
  const restored=kind==='issue'?p.restoreGlobalIssueQueue(original):p.restoreGlobalPrQueue(original)
  assert.equal(restored.notice,undefined)
  assert.deepEqual(restored.items,original.items)
  assert.equal(Object.hasOwn(restored.options,'onError'),false)
  if(kind==='issue') {assert.equal(restored.options.autoMerge,false); assert.equal(restored.options.refinementAllowed,true)}
  else assert.equal(restored.options.conflicts,'rebase-fix')
  assert.equal(JSON.stringify(original),before)
 }
 assert.throws(()=>options({onError:'stop'}), /Queue-Optionen/)
})

test('issue merge consent is explicit and independent from autonomous recovery', () => {
 assert.match(plan({}).prompt,/Nicht mergen und kein Auto-Merge aktivieren/)
 for(const strategy of ['squash','merge','rebase']) {
  const prompt=plan({autoMerge:true,strategy}).prompt
  assert.ok(prompt.includes(`Merge ist für die ausgewählten Issues vorab erlaubt, Strategie ${strategy}`))
  for(const text of ['Nicht erneut pro PR','koordinierende Parent','unabhängige Reviews','Branch-Schutz','aktuellen Head','aktuellem Base','--match-head-commit','MERGED','Post-Merge-Checks','Keine Releases oder Tags']) assert.ok(prompt.includes(text),text)
 }
})

test('real blockers and refinement remain separately scoped across all issue options', () => {
 for(const repositoryExecution of ['sequential','parallel']) for(const blockOnIssue of [true,false]) for(const refinementAllowed of [true,false]) {
  const prompt=plan({repositoryExecution,blockOnIssue,refinementAllowed}).prompt
  evidence(prompt)
  assert.match(prompt,blockOnIssue?/echten Blocker die Queue pausieren/:/echten Blocker nur das betroffene Repository pausieren/)
  assert.match(prompt,refinementAllowed?/aktuellen Body lesen, übrigen Inhalt und konkurrierende Änderungen erhalten/:/Issue-Body nicht verändern/)
  assert.match(prompt,/Required Check sperrt den Merge/)
  assert.match(prompt,/Sicherheitsablehnungen niemals umgehen/)
 }
})

test('review and merge preserve their different authority boundaries', () => {
 const review=p.buildPrQueueGoalPlan(prDraft({})).prompt
 assert.match(review,/Nicht mergen, nicht rebasen und keine Code-\/Branch-Änderungen oder Pushes/)
 assert.match(review,/Review-Ergebnis: COMMENT/)
 const merge=p.buildPrQueueGoalPlan(prDraft({}),{action:'merge'}).prompt
 for(const text of ['bestätigte Merge-Aktion','nicht erneut pro PR','CHANGES_REQUESTED niemals umgehen','App-Identität','strict required checks','--match-head-commit','kein --admin','Kein --auto','MERGED zurücklesen']) assert.ok(merge.includes(text),text)
 for(const conflicts of ['ignore','rebase-fix']) {
  const prompt=p.buildPrQueueGoalPlan(prDraft({conflicts}),{action:'merge'}).prompt
  assert.match(prompt,conflicts==='ignore'?/nicht rebasen, verändern, pushen oder mergen/:/--force-with-lease=<head-ref>/)
  if(conflicts==='rebase-fix') for(const text of ['Fork-PRs','semantisch erhalten','vor einem Push klären','Tests müssen bestehen','neue unabhängige Reviews','Approvals nicht selbst ersetzen']) assert.ok(prompt.includes(text),text)
 }
})

function transport() {
 const calls = [], data = new Map(); let objective = ''
 const storage = { get: (key, fallback) => data.get(key) ?? fallback, set: (key, value) => data.set(key, structuredClone(value)) }
 const api = { openSession: async () => {}, request: async (method, args) => {
  calls.push([method, args])
  if (method === 'session.create') return { session_id: 'runtime', stored_session_id: 'stored' }
  if (method === 'session.title') return {}
  if (method === 'session.control.read') return { control: { goal: objective ? { title: objective, status: 'active' } : null } }
  if (method === 'command.dispatch' && args.arg.startsWith('-- ')) { objective = p.queueGoalObjective({ prompt: args.arg.slice(3) }); return { type: 'send', message: objective } }
  if (method === 'command.dispatch' && args.arg === 'show') return { type: 'exec', output: `Goal (active): ${objective}` }
  if (method === 'prompt.submit') return { status: 'ok' }
  throw new Error(`Unexpected RPC ${method}`)
 } }
 return { api, storage, calls, data }
}


test('preview, stored goal and native kickoff use the same recovery and permission contract', async () => {
 for(const kind of ['issue','pr']) {
  const draft=kind==='issue'?options({autoMerge:true}):prDraft({})
  const preview=kind==='issue'?p.buildQueueGoalPlan(draft):p.buildPrQueueGoalPlan(draft)
  const f=transport()
  const receipt=await (kind==='issue'?p.startIssueQueue:p.startPrQueue)(f.api,draft,{storage:f.storage,plan:preview})
  assert.deepEqual(receipt.plan,preview)
  const submitted=f.calls.find(([method])=>method==='prompt.submit')[1].text
  assert.equal(submitted,p.queueGoalObjective(preview))
  assert.match(submitted,/Patch-, Tool-, Build- und Testfehler selbst diagnostizieren/)
  assert.doesNotMatch(submitted,/Pause-on-error/)
 }
})

test('settings expose meaningful choices instead of contradictory error controls', () => {
 const source=readFileSync(new URL('../desktop/plugin.js',import.meta.url),'utf8')
 assert.doesNotMatch(source,/Queue error policy|Stoppen und fragen|option\('Bei Fehler'/)
 assert.match(source,/Bei nicht lösbaren Hindernissen die ganze Queue pausieren/)
 assert.match(source,/Anforderungen im Issue präzisieren/)
 assert.doesNotMatch(source,/queueExecutionPreview/)
 assert.match(source,/children: plan\.prompt/)
 assert.match(source,/startIssueQueue\(host, draft, \{ storage: pluginCtx.storage, plan/)
 assert.match(source,/startPrQueue\(host, draft, \{ storage: pluginCtx.storage, plan: nextPlan/)
})

test('single-item instruction text stays within a reviewable size', () => {
 const issue=p.updateGlobalIssueQueue(p.emptyGlobalIssueQueue(),{type:'toggle',item:item('octocat/Hello-World',42)})
 const pr=p.updateGlobalPrQueue(p.emptyGlobalPrQueue(),{type:'toggle',item:item('octocat/Hello-World',42)})
 for(const prompt of [p.buildQueueGoalPlan(issue).prompt,p.buildPrQueueGoalPlan(pr).prompt,p.buildPrQueueGoalPlan(pr,{action:'merge'}).prompt]) assert.ok(prompt.length<5000,`${prompt.length} characters`)
})

test('production Issue editor exposes blocker scope only for parallel work and previews the exact prompt', () => {
 const source=readFileSync(new URL('../desktop/plugin.js',import.meta.url),'utf8')
 const start=source.indexOf('function IssueQueueEditor(')
 const component=source.slice(start,source.indexOf('\nfunction PrQueueConflictStatus',start))
 const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
 for(const repositoryExecution of ['sequential','parallel']) {
  const draft=options({repositoryExecution}), changes=[]
  const deps={...p,
   useState:initial=>[initial,()=>{}],useValue:store=>store.get(),useQuery:()=>({data:[]}),useSessionGit:()=>({}),useQueueExecution:()=>({loading:false,error:null}),
   $queueSubmission:{get:()=>null},host:{state:{profile:{get:()=> 'default'},cwd:{get:()=>''}},request:()=>{},openSession:()=>{}},
   jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Button:'button',LabelChip:'span',QueueExecution:'execution',QueueGroup:'fieldset',QueueStatus:'status',QUEUE_CONTROL_STYLE:{},ID:'githermes'
  }
  const Editor=new Function('deps',`with(deps){${component};return IssueQueueEditor}`)(deps)
  const tree=nodes(Editor({draft,change:action=>changes.push(action),busy:false,error:''}))
  const byLabel=label=>tree.find(node=>node.props?.['aria-label']===label)
  assert.equal(byLabel('Queue error policy'),undefined)
  const blocker=byLabel('Bei Blocker gesamtes Goal pausieren')
  assert.equal(!!blocker,repositoryExecution==='parallel')
  if(blocker){blocker.props.onChange({target:{checked:false}});assert.deepEqual(changes.at(-1),{type:'options',options:{blockOnIssue:false}})}
  assert.equal(tree.find(node=>node.type==='pre').props.children,p.buildQueueGoalPlan(draft).prompt)
  assert.ok(byLabel('Auto-merge this queue'))
  assert.ok(byLabel('Anforderungen im Issue präzisieren'))
 }
})
