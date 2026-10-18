import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { relocateShellArtifacts } from '../scripts/test-helpers/shell_fixture.mjs'

const execP = promisify(exec)
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
// Run the shipped shellCommand/shBig/shJsonBig functions, not a second copy of
// their algorithm. Adapt only the host RPC boundary (real local shell + 4k cap).
const transportSource = source.slice(source.indexOf('const shellContexts = new WeakMap()'), source.indexOf('async function ghApiBig(')).replace(/^export /gm, '')
const makeTransport = new Function('host', 'POSIX_PATH', 'sq', `${transportSource}; return { shBig, shJsonBig }`)
const sq = value => "'" + String(value).replace(/'/g, "'\\''") + "'"

test('shBig/shJsonBig survive the gateway cap through the real platform shell', async () => {
  // This is not a gateway approval/redaction test or live gh invocation.
  const root = mkdtempSync(join(tmpdir(), 'githermes-transport-'))
  const posixRoot = process.platform === 'win32' ? root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : root
  let maxStdout = 0, chunkReads = 0
  const cleanups = []
  const host = { request: async (method, { command }) => {
    assert.equal(method, 'shell.exec')
    // Keep all payload/runner artifacts in the task-owned fixture, not /tmp.
    if (command.includes('mktemp ') && command.includes('| base64 -d >')) {
      const match = command.match(/echo ([A-Za-z0-9+/=]+) \| tr/)
      const decoded = relocateShellArtifacts(Buffer.from(match[1], 'base64').toString('utf8'), posixRoot)
      command = relocateShellArtifacts(command.replace(match[1], Buffer.from(decoded).toString('base64')), posixRoot)
    } else command = relocateShellArtifacts(command, posixRoot)
    const running = execP(command, { shell: process.platform === 'win32' ? process.env.ComSpec : '/bin/bash', encoding: 'utf8', maxBuffer: 2 ** 20, env: { ...process.env, TMPDIR: posixRoot } }).catch(error => error)
    cleanups.push(running)
    const result = await running
    if (result instanceof Error && typeof result.code !== 'number') throw result
    const stdout = (result.stdout || '').slice(-4000)
    maxStdout = Math.max(maxStdout, stdout.length)
    if (stdout.length === 3800) chunkReads++

    return { code: typeof result.code === 'number' ? result.code : 0, stdout, stderr: result.stderr || '' }
  } }
  const transport = makeTransport(host, 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ', sq)
  const value = { title: 'SDK cap regression', body: 'ä😀 repeated text\n'.repeat(1500) }
  writeFileSync(join(root, 'payload.json'), JSON.stringify(value))
  try {
    const command = `cat ${sq(`${posixRoot}/payload.json`)}`
    assert.deepEqual(await transport.shJsonBig(command), value)
    assert.equal(await transport.shBig('printf empty'), 'empty')
    assert.equal(await transport.shBig('printf ""'), '')
    await assert.rejects(transport.shBig('printf deliberate-failure >&2; exit 7'), /deliberate-failure/)
    assert.ok(chunkReads > 1, 'must cross several real 3800-char chunks')
    assert.ok(maxStdout <= 4000)
  } finally {
    // shBig's fire-and-forget unlink is intentionally awaited at the RPC seam.
    await Promise.resolve()
    for (let count = -1; count !== cleanups.length;) {
      count = cleanups.length
      await Promise.all(cleanups)
    }
    rmSync(root, { recursive: true, force: true })
  }
})
