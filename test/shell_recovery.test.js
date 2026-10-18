import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(process.env.GITHERMES_BASELINE || new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const classifierStart = source.indexOf('export function classifyGhError(')
const classifierSource = source.slice(classifierStart, source.indexOf('\n}', classifierStart) + 2).replace('export ', '')
const classifyGhError = new Function(`${classifierSource}; return classifyGhError`)()
const transportStart = source.indexOf(source.includes('const shellContexts = new WeakMap()') ? 'const shellContexts = new WeakMap()' : 'let bashPath = null')
const transportSource = source.slice(transportStart, source.indexOf('async function postIssueComment'))
const makeTransport = (host, clientPosix) => new Function('host', 'POSIX_SHELL', 'POSIX_PATH', `${transportSource}; return { shellCommand, sh, resolveBash }`)(host, clientPosix, 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ')
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
test('POSIX backend is detected before commands run, regardless of client platform', async () => {
  const calls = []
  const f = makeTransport({ request: (method, { command }) => {
    calls.push(command)
    assert.equal(command, 'echo GITHERMES_SHELL_%OS%')
    return result('GITHERMES_SHELL_%OS%\n')
  } }, true)
  assert.equal(await f.shellCommand("gh api 'user/repos' | wc -c"), 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; gh api \'user/repos\' | wc -c')
  assert.equal(calls.length, 1)
})

function routedFixture(routes, clientPosix = false) {
  const calls = []
  let active = Object.keys(routes)[0]
  const gateways = Object.fromEntries(Object.entries(routes).map(([id, options]) => [id, {
    request: async (method, { command }) => {
      assert.equal(method, 'shell.exec')
      calls.push({ id, command })
      if (options.run) return options.run(command, () => { active = options.switchTo })
      if (command === 'echo GITHERMES_SHELL_%OS%') {
        if (options.switchTo) active = options.switchTo
        return result(options.bash ? 'GITHERMES_SHELL_Windows_NT\r\n' : 'GITHERMES_SHELL_%OS%\n')
      }
      if (command === 'where git' || command === 'where bash') return result('')
      if (command.includes('%ProgramFiles%')) return result(`"${options.bash}"\r\n`)
      if (command === `"${options.bash}" -c "uname -s"`) return result('MINGW64_NT-10.0\r\n')
      if (options.bash && !command.startsWith(`"${options.bash}" -l -c`)) throw new Error(`POSIX command sent directly to Windows ${id}`)
      if (!options.bash && /bash\.exe/i.test(command)) throw new Error(`Windows command sent to POSIX ${id}`)
      return result(id)
    },
  }]))
  const host = {
    state: { connectionId: { get: () => active }, profile: { get: () => 'default' }, gateway: { get: () => 'connected' } },
    getGateway: () => gateways[active],
    request: (...args) => gateways[active].request(...args),
  }
  return { host, calls, select: id => { active = id }, ...makeTransport(host, clientPosix) }
}

test('a POSIX desktop uses the Windows gateway shell instead of its own OS', async () => {
  const f = routedFixture({ windows: { bash: 'C:\\Program Files\\Git\\bin\\bash.exe' } }, true)
  assert.equal(await f.sh('printf backend'), 'windows')
  assert.ok(f.calls.some(({ command }) => command === 'echo GITHERMES_SHELL_%OS%'))
})

test('shell discovery follows Windows and Linux gateway switches in both directions', async () => {
  const f = routedFixture({ windows: { bash: 'C:\\Program Files\\Git\\bin\\bash.exe' }, linux: {} })
  assert.equal(await f.sh('printf backend'), 'windows')
  f.select('linux')
  assert.equal(await f.sh('printf backend'), 'linux')
  f.select('windows')
  assert.equal(await f.sh('printf backend'), 'windows')
  assert.ok(f.calls.some(({ id, command }) => id === 'linux' && command === 'echo GITHERMES_SHELL_%OS%'))
})

test('different Windows gateways do not share a discovered Git Bash path', async () => {
  const f = routedFixture({ first: { bash: 'C:\\Program Files\\Git\\bin\\bash.exe' }, second: { bash: 'D:\\PortableGit\\bin\\bash.exe' } })
  assert.equal(await f.sh('printf backend'), 'first')
  f.select('second')
  assert.equal(await f.sh('printf backend'), 'second')
})

test('one command keeps its gateway when focus changes during discovery', async () => {
  const f = routedFixture({ first: { bash: 'C:\\Program Files\\Git\\bin\\bash.exe', switchTo: 'second' }, second: {} })
  assert.equal(await f.sh('printf backend'), 'first')
  assert.ok(f.calls.every(({ id }) => id === 'first'))
  assert.equal(await f.sh('printf backend'), 'second')
})

test('legacy SDK refuses a route switch during a command instead of using the new host', async () => {
  const f = routedFixture({ first: { bash: 'C:\\Program Files\\Git\\bin\\bash.exe', switchTo: 'second' }, second: {} })
  delete f.host.getGateway
  await assert.rejects(f.sh('printf backend'), /gateway|connection|route|changed/i)
  assert.ok(f.calls.every(({ id }) => id === 'first'), 'no follow-up RPC may reach the new host')
})

test('a reused gateway object reprobes when its connection or profile changes', async () => {
  let connection = 'one', profile = 'default', probes = 0
  const gateway = { request: async (method, { command }) => {
    if (command === 'echo GITHERMES_SHELL_%OS%') { probes++; return result('GITHERMES_SHELL_%OS%\n') }
    return result(`${connection}/${profile}`)
  } }
  const host = { getGateway: () => gateway, request: gateway.request, state: { connectionId: { get: () => connection }, profile: { get: () => profile } } }
  const f = makeTransport(host, false)
  assert.equal(await f.sh('printf backend'), 'one/default')
  profile = 'worker'
  assert.equal(await f.sh('printf backend'), 'one/worker')
  connection = 'two'
  assert.equal(await f.sh('printf backend'), 'two/worker')
  assert.equal(probes, 3)
})

test('large reads keep creation, payload, chunks and cleanup on their owning gateway', async () => {
  const f = routedFixture({ first: { switchTo: 'second', run: (command, change) => {
    if (command === 'echo GITHERMES_SHELL_%OS%') return result('GITHERMES_SHELL_%OS%\n')
    if (command.includes('mktemp -d')) { change(); return result('/tmp/ghprs.first') }
    if (command.includes('wc -c')) return result('10')
    if (command.includes('tail -c')) return result('68656c6c6f')
    return { code: 0, stdout: '', stderr: '' }
  } }, second: { run: () => { throw new Error('A chunk or cleanup crossed into the newly focused gateway') } } })
  const code = source.slice(transportStart, source.indexOf('async function ghApiBig(')).replace(/^export /gm, '')
  const api = new Function('host', 'POSIX_SHELL', 'sq', 'POSIX_PATH', `${code}; return { shBig }`)(f.host, false, value => `'${String(value).replace(/'/g, `'\\''`)}'`, 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; ')
  assert.equal(await api.shBig('printf hello'), 'hello')
  assert.ok(f.calls.every(({ id }) => id === 'first'))
  assert.ok(f.calls.some(({ command }) => command.includes('rmdir')))
})
test('Windows client with a Linux shell.exec backend does not require Git Bash', async () => {
  // The legacy Desktop flag is deliberately false; only the backend probe counts.
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
  assert.equal(await f.shellCommand('gh repo view CromeSDK/hermes-auto-reasoning'), 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"; gh repo view CromeSDK/hermes-auto-reasoning')
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
