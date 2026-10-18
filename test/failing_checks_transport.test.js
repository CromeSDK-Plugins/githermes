import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,rmSync,readdirSync,statSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {exec} from 'node:child_process'
import {promisify} from 'node:util'
import {host} from '@hermes/plugin-sdk'
import {collectFailingChecks} from '../desktop/plugin.js'
import {relocateShellArtifacts} from '../scripts/test-helpers/shell_fixture.mjs'
const execP=promisify(exec)
test('public collector uploads exact production code through real shell/Python and secret-safe capped hex transport',async()=>{
 const parent=resolve('test/.temporary-fix-collector');mkdirSync(parent,{recursive:true});const root=mkdtempSync(join(parent,'case-'))
 const posix=process.platform==='win32'?root.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>`/${d.toLowerCase()}`):root
 // Synthetic gh subprocess adapter, loaded only by the isolated Python child.
 // Collection, redaction, chunk transport and cleanup are the shipped functions.
 writeFileSync(join(root,'sitecustomize.py'),String.raw`import subprocess,json,types
original=subprocess.run
h='a'*40
checks=[{'id':i+1,'head_sha':h,'name':'public '+str(i),'status':'completed','conclusion':'success'} for i in range(150)]+[{'id':151,'head_sha':h,'name':'external','status':'completed','conclusion':'failure','output':{'title':'Peer conflict','summary':'Error: lockfile conflict','text':'API_KEY="SyntheticTransport9234"\n'+'context ä😀\n'*1500}}]
def run(args,**kwargs):
 if not isinstance(args,list) or args[0]!='gh':return original(args,**kwargs)
 assert args[1]=='api'
 path=args[2]
 if '/pulls/' in path:out={'state':'open','head':{'sha':h,'ref':'renovate/dependency','repo':{'full_name':'octocat/Hello-World'}},'base':{'ref':'main','repo':{'full_name':'octocat/Hello-World'}}}
 elif '/check-runs?' in path:
  page=int(path.rsplit('page=',1)[1]);out={'total_count':len(checks),'check_runs':checks[(page-1)*100:page*100]}
 elif '/statuses?' in path:out=[]
 else:raise AssertionError('Unexpected fixture CLI path')
 return types.SimpleNamespace(returncode=0,stdout=json.dumps(out,ensure_ascii=False).encode(),stderr=b'')
subprocess.run=run
`)
 const jobs=[],carriers=[];let chunks=0;const original=host.request
 host.request=async(method,{command})=>{
  assert.equal(method,'shell.exec')
  const encoded=command.match(/echo ([A-Za-z0-9+/=]+) \| tr/)
  if(encoded){const raw=relocateShellArtifacts(Buffer.from(encoded[1],'base64').toString(),posix);command=relocateShellArtifacts(command.replace(encoded[1],Buffer.from(raw).toString('base64')),posix)}else command=relocateShellArtifacts(command,posix)
  const env={...process.env,PYTHONPATH:root,TMPDIR:posix};for(const key of Object.keys(env))if(/API_KEY|TOKEN|SECRET|PASSWORD/.test(key))delete env[key]
  const job=execP(command,{shell:process.platform==='win32'?process.env.ComSpec:'/bin/bash',env,maxBuffer:2**20}).catch(e=>e);jobs.push(job)
  const r=await job;if(r instanceof Error&&typeof r.code!=='number')throw r
  if((r.stdout||'').length===3800)chunks++
  const files=[]
  const walk=dir=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else files.push(path)}}
  walk(root)
  for(const path of files.filter(n=>/\.raw$|\.hex$/.test(n)))carriers.push(readFileSync(path,'utf8'))
  return {code:typeof r.code==='number'?r.code:0,stdout:(r.stdout||'').slice(-4000),stderr:r.stderr||''}
 }
 try{
  const snapshot=await collectFailingChecks('octocat/Hello-World',10)
  assert.equal(snapshot.statusCheckRollup.length,151);assert.equal(snapshot.failed.length,1)
  assert.match(snapshot.failed[0].excerpt,/lockfile conflict/)
  assert.ok(!JSON.stringify(snapshot).includes('SyntheticTransport9234'));assert.ok(Buffer.byteLength(snapshot.failed[0].excerpt)<=4096)
  assert.ok(chunks>1)
  assert.ok(carriers.length>0);assert.ok(carriers.every(s=>!s.includes('SyntheticTransport9234')))
 }finally{
  for(let n=-1;n!==jobs.length;){n=jobs.length;await Promise.all(jobs)}
  host.request=original;rmSync(root,{recursive:true,force:true});rmSync(parent,{recursive:true,force:true})
 }
})
