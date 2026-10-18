import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(process.env.GITHERMES_BASELINE || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const classifierStart = source.indexOf('export function classifyGhError(')
const classifierSource = source.slice(classifierStart, source.indexOf('\n}', classifierStart) + 2).replace('export ', '')
const classifyGhError = new Function(`${classifierSource}; return classifyGhError`)()
const transportSource = source.slice(source.indexOf('let bashPath = null'), source.indexOf('async function postIssueComment'))
const makeTransport = new Function('host', 'POSIX_SHELL', `${transportSource}; return { shellCommand, sh, resolveBash }`)
const result = stdout => ({ stdout, stderr: '', code: stdout ? 0 : 1 })
function fixture({ git = '', bash = '', defaults = '', found = [], reject } = {}) {
  const calls = []
  const host = { request: async (method, { command }) => {
    assert.equal(method, 'shell.exec')
    calls.push(command)
    if (reject) throw reject
    if (command === 'echo GITHERMES_SHELL_%OS%') return result('GITHERMES_SHELL_Windows_NT\r\n')
    if (command === 'where git') return result(git)
    if (command === 'where bash') return result(bash)
    if (command.includes('%ProgramFiles%')) return result(defaults)
    const match = command.match(/^"([^"]+)" -c "uname -s"$/)
    if (match) return result(found.includes(match[1]) ? 'MINGW64_NT-10.0\r\n' : '')
    // Old plugin uses existence only. Keep that boundary truthful in the before run.
    if (command.startsWith('if exist ')) return result('')
    if (command.includes(' -l -c ')) return { stdout: 'ok', stderr: '', code: 0 }
    throw new Error(`Unexpected command: ${command}`)
  } }
  return { ...makeTransport(host, false), calls }
}

test('Windows finds Program Files Git even when git is absent from PATH', async () => {
  const path = 'C:\\Program Files\\Git\\bin\\bash.exe'
  const f = fixture({ defaults: `${path}\r\n`, found: [path] })
  assert.ok((await f.shellCommand('gh --version')).startsWith(`"${path}" -l -c`))
})
test('Windows finds per-user Git in LocalAppData Programs', async () => {
  const path = 'C:\\Users\\Public\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
  const f = fixture({ defaults: `${path}\r\n`, found: [path] })
  assert.ok((await f.shellCommand('gh --version')).startsWith(`"${path}" -l -c`))
  assert.ok(f.calls.some(c => c.includes('%LOCALAPPDATA%\\Programs\\Git')))
})
test('Windows examines every git PATH entry and supports the bin layout', async () => {
  const path = 'D:\\PortableGit\\bin\\bash.exe'
  const f = fixture({ git: 'C:\\other\\git.exe\r\nD:\\PortableGit\\bin\\git.exe\r\n', found: [path] })
  assert.ok((await f.shellCommand('gh --version')).startsWith(`"${path}" -l -c`))
})
test('where bash accepts verified Git Bash but never invokes the WSL shim', async () => {
  const path = 'D:\\PortableGit\\usr\\bin\\bash.exe'
  const f = fixture({ bash: `C:\\Windows\\System32\\bash.exe\r\n${path}\r\n`, found: [path] })
  assert.ok((await f.shellCommand('gh --version')).startsWith(`"${path}" -l -c`))
  assert.ok(!f.calls.some(c => c.startsWith('"C:\\Windows\\System32')))
})
test('unsafe where output cannot introduce cmd operators or expand variables', async () => {
  const f = fixture({ bash: 'C:\\Git&echo injected\\bash.exe\r\nC:\\%EVIL%\\bash.exe\r\n' })
  await assert.rejects(f.shellCommand('gh --version'), /Git for Windows bash.exe was not found/)
  assert.ok(!f.calls.some(c => c.startsWith('"C:\\Git&') || c.startsWith('"C:\\%EVIL%')))
})
test('missing Bash rejects before executing the data command and Retry reprobes', async () => {
  const f = fixture()
  await assert.rejects(f.shellCommand('gh --version'), /Git for Windows bash.exe was not found/)
  const before = f.calls.length
  await assert.rejects(f.shellCommand('gh --version'), /Git for Windows bash.exe was not found/)
  assert.ok(f.calls.length > before)
  assert.ok(!f.calls.some(c => c.includes('reopen this pane') || c.includes('base64 -d')))
})
test('concurrent probes are shared; successful resolution remains cached', async () => {
  const path = 'D:\\PortableGit\\bin\\bash.exe'
  const f = fixture({ git: 'D:\\PortableGit\\cmd\\git.exe', found: [path] })
  await Promise.all([f.shellCommand('echo 1'), f.shellCommand('echo 2')])
  assert.equal(f.calls.filter(c => c === 'where git').length, 1)
  const before = f.calls.length
  await f.shellCommand('echo 3')
  assert.equal(f.calls.length, before)
})
test('host rejection is not replaced with plugin missing-Bash and can be retried', async () => {
  const error = new Error('shell.exec unavailable: approval safety module not importable')
  const f = fixture({ reject: error })
  await assert.rejects(f.shellCommand('gh --version'), e => e === error)
  await assert.rejects(f.shellCommand('gh --version'), e => e === error)
  assert.equal(f.calls.length, 2)
})
test('POSIX commands remain unchanged without Windows discovery', async () => {
  const f = makeTransport({ request: () => { throw new Error('unexpected probe') } }, true)
  assert.equal(await f.shellCommand("gh api 'user/repos' | wc -c"), "gh api 'user/repos' | wc -c")
})
test('Windows client with a Linux shell.exec backend does not require Git Bash', async () => {
  // POSIX_SHELL false is the Windows Desktop decision (navigator.platform / userAgent).
  // shell.exec here is the remote Linux gateway: /bin/sh does not expand %OS%.
  const calls = []
  const host = { request: async (method, { command }) => {
    assert.equal(method, 'shell.exec')
    calls.push(command)
    if (command === 'echo GITHERMES_SHELL_%OS%') return { stdout: 'GITHERMES_SHELL_%OS%\n', stderr: '', code: 0 }
    if (command === 'where git' || command === 'where bash' || command.includes('%ProgramFiles%') || command.includes('uname -s'))
      return { stdout: '', stderr: 'not found\n', code: 127 }
    throw new Error(`data command ran: ${command}`)
  } }
  const f = makeTransport(host, false)
  assert.equal(await f.shellCommand('gh repo view CromeSDK/hermes-auto-reasoning'), 'gh repo view CromeSDK/hermes-auto-reasoning')
  assert.deepEqual(calls, ['echo GITHERMES_SHELL_%OS%'])
})
test('missing Bash, Windows missing gh and auth have concrete recovery steps', () => {
  for (const raw of ['Git for Windows bash.exe was not found', 'No shell found. Hermes needs bash (Git for Windows on Windows).']) {
    const c = classifyGhError(new Error(raw))
    assert.equal(c.kind, 'bash')
    assert.match(c.detail, /Git for Windows/)
    assert.match(c.detail, /PATH/)
    assert.match(c.detail, /Retry/)
    assert.doesNotMatch(c.detail, /reopen this pane/)
  }
  const c = classifyGhError(new Error("'gh' is not recognized as an internal or external command"))
  assert.equal(c.kind, 'missing')
  assert.equal(c.command, 'gh --version')
  assert.equal(classifyGhError(new Error('authentication required')).command, 'gh auth status')
})
