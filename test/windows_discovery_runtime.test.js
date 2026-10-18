import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const execP = promisify(exec)
const source = readFileSync(process.env.GITHERMES_BASELINE || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const transportSource = source.slice(source.indexOf('const shellContexts = new WeakMap()'), source.indexOf('async function postIssueComment'))
const makeTransport = new Function('host', 'POSIX_SHELL', 'POSIX_PATH', `${transportSource}; return { sh, shellCommand }`)

test('real Windows cmd discovers standard Git Bash with git absent from PATH', { skip: process.platform !== 'win32' }, async t => {
  // No repositories, installs or host config changes. Only this child env loses
  // Git's PATH entries. Exercise the shipped discovery and runner via cmd.exe.
  const candidates = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean).map(p => `${p}\\Git\\bin\\bash.exe`)
  candidates.push(`${process.env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe`)
  if (!candidates.some(existsSync)) { t.skip('this host has no standard-location Git Bash installation'); return }
  const calls = []
  const env = { ...process.env, PATH: `${process.env.SystemRoot}\\System32` }
  const host = { request: async (method, { command }) => {
    assert.equal(method, 'shell.exec')
    calls.push(command)
    const result = await execP(command, { shell: process.env.ComSpec, env, encoding: 'utf8' }).catch(e => e)
    if (result instanceof Error && typeof result.code !== 'number') throw result
    return { code: typeof result.code === 'number' ? result.code : 0, stdout: result.stdout || '', stderr: result.stderr || '' }
  } }
  const before = await host.request('shell.exec', { command: 'where git' })
  assert.notEqual(before.code, 0, 'fixture must remove git from PATH')
  const transport = makeTransport(host, false, 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ')
  assert.equal(await transport.sh('printf windows-standard-path-smoke'), 'windows-standard-path-smoke')
  assert.ok(calls.some(c => c.includes('%ProgramFiles%')))
  assert.ok(calls.some(c => c.includes('uname -s')))
})
