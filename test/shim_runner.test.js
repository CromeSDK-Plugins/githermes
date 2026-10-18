import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFileP = promisify(execFile)

// The Windows runner decodes a base64 command inside bash and executes it from an
// mktemp file. This exercises the real bash half (decode, metachar survival,
// exit-code propagation, mode 600, cleanup). The cmd.exe half is pinned by the
// source assertions in windows_shell.test.js.
function runnerScript(source, b64) {
  const line = source.split('\n').find(l => l.includes(' -c "') && l.includes('base64 -d'))
  assert.ok(line, 'shellCommand runner line missing')
  const start = line.indexOf(' -c "') + ' -c "'.length
  const end = line.lastIndexOf('"')
  return line.slice(start, end).replaceAll('${b64}', b64).replace(/\\(.)/g, (_, c) => c)
}

test('shell: runner uses mktemp and removes the script on success and failure', { skip: process.platform === 'win32' }, async () => {
  const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  assert.equal(source.includes('gt$$'), false, 'predictable gt$$ temp names must not remain')
  const probed = runnerScript(source, 'QQ')
  assert.match(probed, /mktemp \$\{TMPDIR:-\/tmp\}\/gt\.XXXXXX/, 'temp scripts must be created with mktemp')
  assert.match(probed, /trap 'unlink \$f 2>\/dev\/null \|\| true' EXIT INT TERM/, 'cleanup must survive errors via an unlink trap')
  assert.match(probed, /chmod 600 \$f/, 'temp scripts must be mode 600')
  assert.doesNotMatch(probed, /base64 -d \| bash/, 'decoded output must not be piped into a shell')
  assert.doesNotMatch(probed, /gt\$\$/, 'runner must not fall back to a PID filename')

  const root = mkdtempSync(join(tmpdir(), 'githermes-mktemp-'))
  const spaced = join(root, 'a b')
  mkdirSync(spaced)
  const b64Of = s => Buffer.from(s, 'utf8').toString('base64')
  const run = (payload, dir) => execFileP('/bin/bash', ['-c', runnerScript(source, b64Of(payload))], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: dir },
  }).catch(e => e)
  try {
    const results = await Promise.all([
      run(`echo 'a|b&&c%d'`, root), // pipes, && and % must arrive verbatim
      run('printf no_newline_ok', root),
      run('echo bad && exit 7', root), // exit code must propagate through the trap
      run(`p=$0; mode=$(stat -c %a "$p" 2>/dev/null || stat -f %Lp "$p"); printf '%s %s' "$mode" "$p"`, root),
      run('printf spaced-ok', spaced),
    ])
    assert.equal(results[0].stdout.trim(), 'a|b&&c%d')
    assert.equal(results[1].stdout, 'no_newline_ok')
    assert.equal(results[2].code, 7)
    const identity = String(results[3].stdout || '')
    const match = identity.match(/^600 (.+)$/)
    assert.ok(match, `expected mode 600 and the temp path, got ${JSON.stringify(identity)}`)
    assert.match(match[1], /\/gt\.[A-Za-z0-9]{6}$/, 'temp name must be mktemp randomness, not a PID')
    assert.doesNotMatch(match[1], /\/gt\d+\.sh$/, 'PID temp names are predictable')
    assert.equal(results[4].stdout, 'spaced-ok')
    assert.deepEqual(readdirSync(root).filter(name => name !== 'a b'), [], 'runner left temp scripts behind')
    assert.deepEqual(readdirSync(spaced), [], 'runner left temp scripts behind in a spaced TMPDIR')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
