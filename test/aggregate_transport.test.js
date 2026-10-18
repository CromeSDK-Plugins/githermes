import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {exec} from 'node:child_process'
import {promisify} from 'node:util'
import { relocateShellArtifacts } from '../scripts/test-helpers/shell_fixture.mjs'
const execP=promisify(exec)
const source=readFileSync(new URL('../desktop/plugin.js',import.meta.url),'utf8')
const transport=source.slice(source.indexOf('let bashPath = null'),source.indexOf('async function ghApiBig(')).replace(/^export /gm,'')
const aggregate=source.slice(source.indexOf('let aggregateQueue = Promise.resolve()'),source.indexOf('export async function fetchAggregatePage'))
const sq=v=>"'"+String(v).replace(/'/g,"'\\''")+"'"
test('combined GraphQL input/partial-error envelope crosses the real Windows shell and capped hex transport',async()=>{
 const root=mkdtempSync(join(tmpdir(),'githermes-aggregate-'))
 const posix=process.platform==='win32'?root.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>`/${d.toLowerCase()}`):root
 const cli=join(root,'fixture.mjs')
 writeFileSync(cli,`import {readFileSync} from 'node:fs';const i=process.argv.indexOf('--input');if(process.argv[i+1]!=='-')throw new Error('Expected stdin transport');const input=JSON.parse(readFileSync(0,'utf8'));if(!input.variables.payload)process.exit(9);process.stdout.write(JSON.stringify({data:{payload:input.variables.payload},errors:[{message:'Synthetic SAML',path:['s1']}]}));process.exitCode=1;`)
 const pending=[];let reads=0
 const host={request:async(method,{command})=>{
  assert.equal(method,'shell.exec')
  const b64=command.match(/echo ([A-Za-z0-9+/=]+) \| tr/)
  if(b64){const decoded=relocateShellArtifacts(Buffer.from(b64[1],'base64').toString(),posix);command=relocateShellArtifacts(command.replace(b64[1],Buffer.from(decoded).toString('base64')),posix)}
  else command=relocateShellArtifacts(command,posix)
  const job=execP(command,{shell:process.platform==='win32'?process.env.ComSpec:'/bin/bash',maxBuffer:2**20,env:{...process.env,TMPDIR:posix}}).catch(e=>e);pending.push(job)
  const r=await job;if(r instanceof Error&&typeof r.code!=='number')throw r
  if((r.stdout||'').length===3800)reads++
  return {code:typeof r.code==='number'?r.code:0,stdout:(r.stdout||'').slice(-4000),stderr:r.stderr||''}
 }}
 const GH=`node ${sq(cli.replace(/\\/g,'/'))}`
 const run=new Function('host','POSIX_SHELL','sq','GH',`${transport};${aggregate};return runAggregateGraphql`)(host,process.platform!=='win32',sq,GH)
 const payload='ä😀 mixed JSON\n'.repeat(450)
 try{
  const result=await run({query:'query($payload:String!){viewer{login}}',variables:{payload}})
  assert.equal(result.data.payload,payload);assert.equal(result.errors[0].message,'Synthetic SAML');assert.ok(reads>1)
 }finally{
  for(let n=-1;n!==pending.length;){n=pending.length;await Promise.all(pending)}
  rmSync(root,{recursive:true,force:true})
 }
})
test('search pacing serializes even failure/retry and stays below 30 requests per minute',async()=>{
 const text=aggregate.slice(0,aggregate.indexOf('async function runAggregateGraphql'))
 let now=10_000,delays=[],starts=[]
 const pace=new Function('Date','setTimeout',`${text};return paceAggregate`)({now:()=>now},(callback,ms)=>{delays.push(ms);now+=ms;callback()})
 const a=pace(async()=>{starts.push(now);throw new Error('fail')});const b=pace(async()=>{starts.push(now);return 'ok'});const c=pace(async()=>{starts.push(now);return 'next'})
 await assert.rejects(a,/fail/);assert.equal(await b,'ok');assert.equal(await c,'next');assert.deepEqual(delays,[2200,2200]);assert.deepEqual(starts,[10000,12200,14400])
})
