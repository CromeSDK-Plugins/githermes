import test from 'node:test'
import assert from 'node:assert/strict'
import { exec, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execP = promisify(exec)
const execFileP = promisify(execFile)
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const bashBin = process.platform === 'win32' ? 'bash' : '/bin/bash'
const DIR_NAME = /^(?:ghprs\.cmt|ghprs|ghfix|ghaggregate)\.[A-Za-z0-9]{6}$/

function sliceFn(mark) {
  const start = source.indexOf(mark)
  assert.ok(start >= 0, `missing ${mark}`)
  const rest = source.slice(start)
  const next = rest.slice(mark.length).search(/\n(?:export )?(?:async )?function /)
  return next < 0 ? rest : rest.slice(0, mark.length + next)
}

function runnerScript(b64) {
  const line = source.split('\n').find(l => l.includes(' -c "') && l.includes('base64 -d'))
  assert.ok(line, 'shellCommand runner line missing')
  const start = line.indexOf(' -c "') + ' -c "'.length
  const end = line.lastIndexOf('"')
  return line.slice(start, end).replaceAll('${b64}', b64).replace(/\\(.)/g, (_, c) => c)
}

function toPosix(p) {
  if (process.platform !== 'win32') return p
  return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`)
}

function loadApi(host, posixShell) {
  const transport = source.slice(source.indexOf('let bashPath = null'), source.indexOf('async function ghApiBig(')).replace(/^export /gm, '')
  const collect = source.slice(source.indexOf('export async function collectFailingChecks'), source.indexOf('export function startFixChecks')).replace(/^export /gm, '')
  const collector = source.slice(source.indexOf('export const FIX_CHECK_COLLECTOR'), source.indexOf('export function reviewState')).replace(/^export /gm, '')
  const aggregate = source.slice(source.indexOf('let aggregateQueue = Promise.resolve()'), source.indexOf('export async function fetchAggregatePage'))
  return new Function('host', 'POSIX_SHELL', 'sq', 'GH', `${transport}\n${collect}\n${collector}\n${aggregate}\nreturn { sh, shBig, postIssueComment, collectFailingChecks, runAggregateGraphql }`)(
    host,
    posixShell,
    value => `'${String(value).replace(/'/g, `'\\''`)}'`,
    'false',
  )
}

function commandResult(result) {
  if (result instanceof Error && typeof result.code !== 'number') throw result
  return {
    code: typeof result.code === 'number' ? result.code : 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  }
}

async function modeOf(posixPath) {
  const q = `'${posixPath.replace(/'/g, `'\\''`)}'`
  const result = commandResult(await execFileP(bashBin, ['-c', `stat -c %a ${q} 2>/dev/null || stat -f %Lp ${q}`], { encoding: 'utf8' }).catch(error => error))
  assert.equal(result.code, 0, result.stderr)
  return result.stdout.trim()
}

function makeHost(work, posixWork, seen, pending, kind) {
  return { request: async (method, { command }) => {
    assert.equal(method, 'shell.exec')
    assert.doesNotMatch(command, /Date\.now\(\)|Math\.random|rm -rf|base64 -d \| bash/)
    assert.doesNotMatch(command, /(^|[;&|]\s*)rm\s/, 'cleanup must not be rm')
    if (command.includes('mktemp -d')) assert.match(command, /chmod 700/)
    let result
    if (kind === 'cmd') {
      const job = execP(command, {
        shell: process.env.ComSpec,
        encoding: 'utf8',
        maxBuffer: 2 ** 20,
        env: { ...process.env, TMPDIR: posixWork },
      }).catch(error => error)
      pending.push(job)
      result = commandResult(await job)
    } else {
      const script = kind === 'runner' ? runnerScript(Buffer.from(command, 'utf8').toString('base64')) : command
      const job = execFileP(bashBin, ['-c', script], {
        encoding: 'utf8',
        maxBuffer: 2 ** 20,
        env: { ...process.env, TMPDIR: posixWork },
      }).catch(error => error)
      pending.push(job)
      result = commandResult(await job)
    }
    for (const name of readdirSync(work)) {
      if (seen.some(dir => dir.name === name)) continue
      const posix = `${posixWork}/${name}`
      try {
        const mode = await modeOf(posix)
        seen.push({ name, mode, posix })
      } catch {
        // Runner scripts are files, not the temp directory under test.
      }
    }
    return result
  } }
}

async function settle(pending) {
  for (let count = -1; count !== pending.length;) {
    count = pending.length
    await Promise.all(pending)
    await new Promise(resolve => setImmediate(resolve))
  }
}

async function exercise(kind) {
  const root = mkdtempSync(join(tmpdir(), 'githermes-mktemp-dir-'))
  const work = join(root, 'a b')
  mkdirSync(work)
  const posixWork = toPosix(work)
  const seen = []
  const pending = []
  const posixShell = kind !== 'cmd' && kind !== 'backend'
  const api = loadApi(makeHost(work, posixWork, seen, pending, kind), posixShell)
  const check = async (label, run) => {
    const before = seen.length
    await run()
    await settle(pending)
    const created = seen.slice(before)
    assert.ok(created.length > 0, `${label} did not create a temp directory in TMPDIR`)
    for (const dir of created) {
      // Git Bash on NTFS still runs chmod 700, then stat reports 755: the mount
      // synthesizes directory +x. Linux and macOS keep the real 700 mode.
      assert.match(dir.mode, process.platform === 'win32' ? /^(700|755)$/ : /^700$/, `${label} mode ${dir.mode} for ${dir.name}`)
      assert.match(dir.name, DIR_NAME, `${label} predictable name ${dir.name}`)
      assert.ok(dir.posix.startsWith(`${posixWork}/`), `${label} ignored TMPDIR: ${dir.posix}`)
    }
    assert.deepEqual(readdirSync(work), [], `${label} left ${readdirSync(work).join(', ')}`)
  }
  try {
    await check('shBig success', async () => {
      assert.equal(await api.shBig('printf hello-temp'), 'hello-temp')
    })
    await check('shBig failure', async () => {
      await assert.rejects(api.shBig('printf no-temp >&2; exit 7'), /no-temp/)
    })
    await check('postIssueComment failure', async () => {
      await assert.rejects(api.postIssueComment('octocat/Hello-World', 1, 'hello ä'))
    })
    await check('collectFailingChecks failure', async () => {
      await assert.rejects(api.collectFailingChecks('octocat/Hello-World', 1, {
        run: () => api.sh('printf collector-fail >&2; exit 4'),
      }), /collector-fail/)
    })
    await check('runAggregateGraphql failure', async () => {
      await assert.rejects(api.runAggregateGraphql({ query: 'query { viewer { login } }', variables: { ok: true } }))
    })
  } finally {
    await settle(pending)
    rmSync(root, { recursive: true, force: true })
  }
}

test('temp paths no longer use Date.now or Math.random', () => {
  const marks = [
    'async function postIssueComment',
    'async function shBig',
    'export async function collectFailingChecks',
    'async function runAggregateGraphql',
  ]
  for (const mark of marks) {
    assert.doesNotMatch(sliceFn(mark), /Date\.now\(\)|Math\.random/, mark)
  }
  const live = source.split('\n').filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
  for (const line of live) {
    if (!/Date\.now\(\)|Math\.random/.test(line)) continue
    assert.doesNotMatch(line, /\/tmp|mktemp|ghprs|ghfix|ghaggregate|tempDir|tag = /, `predictable temp path: ${line.trim()}`)
  }
  const mktemp = live.filter(line => line.includes('mktemp -d'))
  assert.equal(mktemp.length, 1, 'multi-call temp directories must be created with one mktemp -d helper')
  assert.match(mktemp[0], /\$\{TMPDIR:-\/tmp\}/)
  assert.match(mktemp[0], /chmod 700/)
  assert.match(mktemp[0], /set -f/)
  assert.match(mktemp[0], /\bIFS=/)
  assert.doesNotMatch(mktemp[0], /"/, 'mktemp command must not use inner double quotes')
  assert.ok(live.some(line => line.includes('rmdir')), 'directory cleanup must use rmdir')
  assert.ok(!live.some(line => /rm -rf|base64 -d \| bash|\brm\s/.test(line)), 'gateway-blocked rm or base64 pipe')
  for (const mark of marks) {
    const fin = sliceFn(mark).slice(sliceFn(mark).lastIndexOf('finally'))
    assert.match(fin, /await /, `${mark} must await cleanup in finally`)
    assert.match(fin, /removeTempDir|rmdir/, `${mark} must remove the temp directory`)
  }
})

test('POSIX shell creates mode 700 temp dirs and clears TMPDIR on success and failure', { skip: process.platform === 'win32' }, () => exercise('posix'))
test('Linux backendPosix shell creates mode 700 temp dirs and clears TMPDIR on failure', { skip: process.platform === 'win32' }, () => exercise('backend'))
test('Windows runner bash half creates mode 700 temp dirs and clears TMPDIR on failure', { skip: process.platform === 'win32' }, () => exercise('runner'))
test('cmd.exe Git Bash runner creates mode 700 temp dirs and clears TMPDIR on failure', { skip: process.platform !== 'win32' }, () => exercise('cmd'))
