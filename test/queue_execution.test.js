import test from 'node:test'
import assert from 'node:assert/strict'
import * as p from '../desktop/plugin.js'
const model = p.queueModelKey('openai-codex', 'gpt-6.1-sol')
const catalog = () => ({ model: 'gpt-6.1-sol', provider: 'openai-codex', providers: [
 { slug: 'openai-codex', models: ['gpt-6.1-sol', 'gpt-5.5'], capabilities: { 'gpt-6.1-sol': { reasoning: true, fast: true }, 'gpt-5.5': { reasoning: true, fast: true } } },
 { slug: 'custom:fixture', models: ['plain'], capabilities: { plain: { reasoning: false, fast: false } } },
] })
function fixture(kind='issue', options={model,reasoning:'high',fast:'off'}) {
 const empty=kind==='pr'?p.emptyGlobalPrQueue:p.emptyGlobalIssueQueue, update=kind==='pr'?p.updateGlobalPrQueue:p.updateGlobalIssueQueue
 let draft=update(empty(),{type:'toggle',item:{repo:'octocat/Hello-World',number:9,title:'Fixture',author:{login:'other'}}})
 draft=update(draft,{type:'options',options})
 const plan=kind==='pr'?p.buildPrQueueGoalPlan(draft):p.buildQueueGoalPlan(draft)
 const data=new Map(), calls=[], flags={}
 const storage={get:(k,v)=>data.get(k)??v,set:(k,v)=>data.set(k,structuredClone(v))}
 let prompt='', chosen
 const api={openSession:async()=>{},request:async(m,a)=>{
  calls.push([m,a]);
  if(m==='model.options') return flags.stale?{...catalog(),providers:[]}:catalog()
  if(m==='session.create'){chosen=a; return {session_id:'runtime',stored_session_id:'stored',info:{model:flags.modelMismatch?'wrong':a.model||catalog().model,provider:a.provider}}}
  if(m==='session.resume') return {session_id:'resumed',stored_session_id:'stored',info:{model:flags.resumeMismatch?'wrong':chosen.model||catalog().model,provider:chosen.provider}}
  if(m==='config.get') return {value:flags[a.key+'Mismatch']?'wrong':a.key==='reasoning'?chosen.reasoning_effort:chosen.fast?'fast':'normal'}
  if(m==='session.title')return {}
  if(m==='session.control.read')return {control:{goal:prompt?{title:prompt,status:'active'}:null}}
  if(m==='command.dispatch'){if(a.arg==='show')return {type:'exec',output:`Goal (active): ${prompt}`};prompt=p.queueGoalObjective({prompt:a.arg.slice(3)});return {type:'send',message:prompt}}
  if(m==='prompt.submit'){if(flags.reject){flags.reject=false;throw Object.assign(new Error('definite rejection'),{code:4004})}return {status:'ok'}}
  throw Error(m)
 }}
 const run=()=>kind==='pr'?p.startPrQueue(api,draft,{storage,plan}):p.startIssueQueue(api,draft,{storage,plan})
 return {draft,plan,storage,data,calls,flags,run,api}
}
test('legacy Issue and PR drafts retain items/preferences, inherit new fields, preserve receipt fingerprint',()=>{
 for(const kind of ['issue','pr']) {
  const f=fixture(kind,{}), old=structuredClone(f.draft)
  delete old.options.model;delete old.options.reasoning;delete old.options.fast
  const restored=kind==='pr'?p.restoreGlobalPrQueue(old):p.restoreGlobalIssueQueue(old)
  assert.deepEqual(restored.items,old.items)
  assert.deepEqual(p.queueExecutionOptions(restored.options),{model:'',reasoning:'',fast:''})
  assert.equal(JSON.stringify(kind==='pr'?p.buildPrQueueGoalPlan(restored):p.buildQueueGoalPlan(restored)),JSON.stringify(f.plan))
  assert.equal(Object.hasOwn(f.plan,'execution'),false)
 }
})
test('validates exact composite model identity and every saved execution field',()=>{
 const f=fixture()
 for(const options of [{model:'gpt-6.1-sol'},{model:'["", "x"]'},{model:p.queueModelKey('x','x\nverify: bad')},{reasoning:'ultra'},{reasoning:null},{fast:false},{fast:'auto'}]) assert.throws(()=>p.updateGlobalIssueQueue(f.draft,{type:'options',options}))
 assert.deepEqual(p.validateQueueExecution({model,reasoning:'high',fast:'off'},catalog()),{model:'gpt-6.1-sol',provider:'openai-codex',reasoning_effort:'high',fast:false})
 assert.deepEqual(p.validateQueueExecution({},catalog()),{})
 assert.deepEqual(p.queueReasoningLevels('openai-codex','gpt-6.1-sol',{reasoning:true}),['low','medium','high','xhigh','max'])
 assert.deepEqual(p.queueReasoningLevels('openai-codex','gpt-5.5',{reasoning:true}),['none','low','medium','high','xhigh'])
 assert.deepEqual(p.queueReasoningLevels('custom:fixture','plain',{reasoning:true}),[])
 assert.throws(()=>p.validateQueueExecution({reasoning:'none'},catalog()),/Reasoning/)
 assert.throws(()=>p.validateQueueExecution({model:p.queueModelKey('custom:fixture','plain'),fast:'on'},catalog()),/Fast/)
})
test('profile changes reset model-dependent picks without changing order or merge preferences',()=>{
 for(const kind of ['issue','pr']) {
  const f=fixture(kind),update=kind==='pr'?p.updateGlobalPrQueue:p.updateGlobalIssueQueue
  const d=update(f.draft,{type:'options',options:{profile:'worker'}})
  assert.deepEqual(d.items,f.draft.items);assert.equal(d.options.strategy,f.draft.options.strategy)
  assert.deepEqual(p.queueExecutionOptions(d.options),{model:'',reasoning:'',fast:''})
 }
})
test('selection changes fingerprints for Issues, Review and Merge without losing receipt identities',()=>{
 for(const kind of ['issue','pr']) {
  const f=fixture(kind),update=kind==='pr'?p.updateGlobalPrQueue:p.updateGlobalIssueQueue
  for(const options of [{model:p.queueModelKey('openai-codex','gpt-5.5')},{reasoning:'low'},{fast:'on'}]) {
   const d=update(f.draft,{type:'options',options})
   const plan=kind==='pr'?p.buildPrQueueGoalPlan(d):p.buildQueueGoalPlan(d)
   assert.notEqual(JSON.stringify(plan),JSON.stringify(f.plan));assert.match(plan.prompt,/Session-Einstellungen/)
  }
 }
})
for(const kind of ['issue','pr']) {
 test(`${kind}: fresh catalog, exact overrides and readback before Goal and kickoff, duplicate clicks share one Session`,async()=>{
  const f=fixture(kind);await Promise.all([f.run(),f.run()])
  const create=f.calls.find(c=>c[0]==='session.create')[1]
  assert.equal(create.fast,false);assert.equal(create.reasoning_effort,'high');assert.equal(create.model,'gpt-6.1-sol');assert.equal(create.provider,'openai-codex')
  assert.equal(f.calls.filter(c=>c[0]==='session.create').length,1)
  assert.equal(f.calls.filter(c=>c[0]==='prompt.submit').length,1)
  assert.equal(f.calls[0][0],'model.options')
  const dispatch=f.calls.findIndex(c=>c[0]==='command.dispatch')
  assert.deepEqual(f.calls.slice(0,dispatch).filter(c=>c[0]==='config.get').map(c=>c[1].key),['reasoning','fast'])
  assert.equal(f.calls.filter(c=>c[0]==='config.get').length,4)
 })
 test(`${kind}: default values omit all native overrides`,async()=>{
  const f=fixture(kind,{});await f.run()
  const create=f.calls.find(c=>c[0]==='session.create')[1]
  for(const key of ['model','provider','reasoning_effort','fast','service_tier'])assert.equal(Object.hasOwn(create,key),false)
 })
 test(`${kind}: stale catalog blocks before creation`,async()=>{
  const f=fixture(kind);f.flags.stale=true;await assert.rejects(f.run(),/nicht mehr verfügbar/)
  assert.equal(f.calls.some(c=>c[0]==='session.create'),false)
 })
 test(`${kind}: inherited model is not overridden; explicit settings cannot race onto a different profile model`,async()=>{
  const f=fixture(kind,{reasoning:'high',fast:'off'});f.flags.modelMismatch=true
  await assert.rejects(f.run(),/Session-Profilmodell/)
  assert.equal(f.calls.some(c=>c[0]==='command.dispatch'||c[0]==='prompt.submit'),false)
  const create=f.calls.find(c=>c[0]==='session.create')[1]
  assert.equal(Object.hasOwn(create,'model'),false)
  assert.equal(Object.hasOwn(create,'provider'),false)
  f.flags.modelMismatch=false;await f.run()
  assert.equal(f.calls.filter(c=>c[0]==='session.create').length,1)
 })
 for(const key of ['model','reasoning','fast']) test(`${kind}: ${key} mismatch blocks Goal and prompt, preserves same Session for retry`,async()=>{
  const f=fixture(kind);f.flags[key+'Mismatch']=true;await assert.rejects(f.run(),/nicht bestätigt/)
  assert.equal(f.calls.some(c=>c[0]==='command.dispatch'||c[0]==='prompt.submit'),false)
  f.flags[key+'Mismatch']=false;await f.run()
  assert.equal(f.calls.filter(c=>c[0]==='session.create').length,1)
  assert.equal(f.calls.filter(c=>c[0]==='prompt.submit').length,1)
 })
  test(`${kind}: actual hot-reloaded module resumes persisted exact configuration without a second Session`,async()=>{
  const f=fixture(kind);f.flags.reject=true;await assert.rejects(f.run(),/definite/)
  const cold=await import(`../desktop/plugin.js?execution-reload=${kind}-${Date.now()}`)
  const key=kind==='pr'?'prQueueGoalSubmission':'queueGoalSubmission',before=structuredClone(f.data.get(key))
  if(kind==='pr')await cold.startPrQueue(f.api,f.draft,{storage:f.storage,plan:f.plan})
  else await cold.startIssueQueue(f.api,f.draft,{storage:f.storage,plan:f.plan})
  const after=f.data.get(key)
  assert.equal(after.idempotencyKey,before.idempotencyKey)
  assert.equal(after.stored_session_id,before.stored_session_id)
  assert.equal(after.stage,'complete')
  assert.equal(f.calls.filter(c=>c[0]==='session.create').length,1)
  assert.equal(f.calls.filter(c=>c[0]==='session.resume').length,1)
 })
 test(`${kind}: cold retry reads same Session, wrong resumed model cannot leak`,async()=>{
  const f=fixture(kind);f.flags.reject=true;await assert.rejects(f.run(),/definite/)
  const key=kind==='pr'?'prQueueGoalSubmission':'queueGoalSubmission', receipt=f.data.get(key), idem=receipt.idempotencyKey
  f.flags.resumeMismatch=true;await assert.rejects(f.run(),/Session-Modell/)
  assert.equal(f.calls.filter(c=>c[0]==='prompt.submit').length,1)
  f.flags.resumeMismatch=false;await f.run()
  assert.equal(f.calls.filter(c=>c[0]==='session.create').length,1)
  assert.equal(f.data.get(key).idempotencyKey,idem)
 })
}
