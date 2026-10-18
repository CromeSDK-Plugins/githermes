import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { relocateShellArtifacts } from '../scripts/test-helpers/shell_fixture.mjs'
import { projectPaginatedItems } from '../desktop/plugin.js'

const execP = promisify(exec)
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const sq = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
const productionTransport = source.slice(source.indexOf('const shellContexts = new WeakMap()'), source.indexOf('async function ghApiBig(')).replace(/^export /gm, '')
const looseStart = source.indexOf('async function shJsonLoose(')
const productionChecks = source.slice(looseStart, source.indexOf('\n}', looseStart) + 2)

async function transportFixture(work) {
  const root = mkdtempSync(join(tmpdir(), 'githermes-github-'))
  const posix = process.platform === 'win32' ? root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : root
  const worker = join(root, 'fixture.mjs')
  writeFileSync(worker, `import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args[0]==='api') {
  if(args[args.indexOf('--input')+1]!=='-')throw new Error('JSON must be read from stdin');
  process.stdout.write(JSON.stringify({endpoint:args[1],method:args[args.indexOf('--method')+1],data:JSON.parse(readFileSync(0,'utf8'))}));
} else {
  process.stdout.write(readFileSync(args[0],'utf8'));
  if(args[2])process.stderr.write(args[2]);
  process.exitCode=Number(args[1]);
}`)
  const commands = [], jobs = []
  const host = { request: async (method, { command }) => {
    assert.equal(method, 'shell.exec')
    commands.push(command)
    const encoded = command.match(/echo ([A-Za-z0-9+/=]+) \| tr/)
    if (encoded) {
      const decoded = relocateShellArtifacts(Buffer.from(encoded[1], 'base64').toString('utf8'), posix)
      command = relocateShellArtifacts(command.replace(encoded[1], Buffer.from(decoded).toString('base64')), posix)
    } else command = relocateShellArtifacts(command, posix)
    const job = execP(command, {
      shell: process.platform === 'win32' ? process.env.ComSpec : '/bin/bash',
      encoding: 'utf8', maxBuffer: 2 ** 20, windowsHide: true, env: { ...process.env, TMPDIR: posix },
    }).catch(error => error)
    jobs.push(job)
    const result = await job
    if (result instanceof Error && typeof result.code !== 'number') throw result
    return { code: typeof result.code === 'number' ? result.code : 0, stdout: (result.stdout || '').slice(-4000), stderr: result.stderr || '' }
  } }
  const cli = `node ${sq(worker.replace(/\\/g, '/'))}`
  const make = new Function('host', 'POSIX_PATH', 'sq', 'GH', `${productionTransport};${productionChecks};return {shBig,shJsonBig,shJsonLoose,withTextFile,writeGithubJson}`)
  const transport = make(host, 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ', sq, cli)
  try { await work({ ...transport, root, posix, cli, commands }) }
  finally {
    for (let count = -1; count !== jobs.length;) { count = jobs.length; await Promise.all(jobs) }
    const remaining = readdirSync(root).filter(name => name !== 'fixture.mjs' && name !== 'checks.json' && name !== 'empty.txt')
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(remaining, [], 'transport temporary files must be cleaned up')
  }
}

test('issue and PR JSON bodies survive the real platform shell and gateway cap without inline-body limits', async () => {
  await transportFixture(async ({ writeGithubJson, withTextFile, commands }) => {
    const data = { title: 'Quotes " and apostrophe \'', body: 'ä😀\n`literal` $(literal) %PATH% & | < > \' "\r\n'.repeat(160) }
    for (const [endpoint, method] of [['repos/owner/repo/issues', 'POST'], ['repos/owner/repo/issues/4', 'PATCH'], ['repos/owner/repo/pulls/4', 'PATCH']]) {
      const result = await writeGithubJson(endpoint, method, data)
      assert.deepEqual(result, { endpoint, method, data })
    }
    assert.ok(commands.every(command => !command.includes(data.body)))
    if (process.platform === 'win32') assert.ok(commands.every(command => command.length < 8191), 'every Windows command must stay below cmd.exe limit')
    await assert.rejects(withTextFile('temporary body', async () => { throw new Error('synthetic request rejection') }), /synthetic request rejection/)
  })
})

test('paginated review projection retains decision and timestamp with a renderable author', () => {
  const input = [{ id: 8, user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Please fix this.', html_url: 'https://github.com/owner/repo/pull/4#pullrequestreview-8', submitted_at: '2026-01-01T00:00:00Z' }]
  const rows = projectPaginatedItems(input, '[.[]|{user:.user.login,state,html_url,body:(.body//""),submitted_at}]')
  assert.equal(rows[0].user, 'reviewer')
  assert.equal(rows[0].state, 'CHANGES_REQUESTED')
  assert.equal(rows[0].submitted_at, input[0].submitted_at)
  assert.equal(rows[0].body, input[0].body)
})

test('large failing and pending check responses retain all rows and preserve real errors', async () => {
  await transportFixture(async ({ shJsonLoose, root, posix, cli }) => {
    const rows = Array.from({ length: 75 }, (_, index) => ({ name: `CI job ${index} ä😀`, state: 'PENDING', bucket: 'pending', link: `https://github.com/owner/repo/actions/runs/${index}` }))
    writeFileSync(join(root, 'checks.json'), JSON.stringify(rows))
    writeFileSync(join(root, 'empty.txt'), '')
    const command = code => `${cli} ${sq(`${posix}/checks.json`)} ${code}`
    for (const code of [0, 1, 8]) assert.deepEqual(await shJsonLoose(command(code)), rows)
    await assert.rejects(shJsonLoose(`${command(2)} ${sq('authentication failed')}`), /authentication failed|exit 2/)
    await assert.rejects(shJsonLoose(`${cli} ${sq(`${posix}/empty.txt`)} 1 ${sq('no checks reported on this branch')}`), /no checks reported/)
    await assert.rejects(shJsonLoose(`${cli} ${sq(`${posix}/empty.txt`)} 8 ${sq('unexpected empty response')}`), /unexpected empty response|exit 8|empty/i)
  })
})

test('PR conversation includes reviews after the first API page', async () => {
  const start = source.indexOf('  const convQ = useQuery({', source.indexOf('function PrDetail('))
  const querySource = source.slice(start, source.indexOf('  const filesQ = useQuery({', start))
  const reviews = Array.from({ length: 130 }, (_, index) => ({ user: `reviewer-${index}`, state: index === 129 ? 'CHANGES_REQUESTED' : 'COMMENTED', body: `Review ${index}`, submitted_at: '2026-01-01T00:00:00Z' }))
  const paginated = async (_repo, path) => path.includes('/reviews') ? reviews : []
  const firstPage = async (_repo, path) => path.includes('/reviews') ? reviews.slice(0, 15) : []
  const query = new Function('useQuery', 'repo', 'n', 'number', 'active', 'page', 'ghApiBigPaginatedProjected', 'ghApiBig', 'groupInlineThreads', 'livePollInterval', 'headerQ', 'ID', `${querySource};return convQ.queryFn`)(
    options => options, 'owner/repo', '4', 4, true, 'conversation', paginated, firstPage, value => value, () => false, {}, 'githermes',
  )
  const result = await query()
  assert.equal(result.reviews.length, 130)
  assert.equal(result.reviews.at(-1).state, 'CHANGES_REQUESTED')
})
