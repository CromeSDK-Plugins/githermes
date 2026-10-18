import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// Shell invocation is platform-sensitive: the same command string crosses a
// POSIX login shell on macOS/Linux and cmd.exe on Windows. Everything the
// plugin pipes through `shBig` (od / tr / wc / tail / printf / unlink / /tmp)
// only exists on the POSIX side.
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

test('shell: every gh/hermes invocation resolves the binary per platform', () => {
  // A hardcoded `PATH=/opt/homebrew/...:$PATH gh` prefix is a VARIABLE NAMES
  // assignment under cmd.exe: gh never runs and the call "succeeds" with empty
  // stdout, which is worse than a visible failure.
  assert.ok(!source.includes("const GH = 'PATH="), 'GH must not hardcode a POSIX PATH prefix')
  assert.ok(!source.includes("const HERMES = 'PATH="), 'HERMES must not hardcode a POSIX PATH prefix')
  assert.ok(source.includes('const POSIX_SHELL ='), 'platform detection is missing')
  assert.ok(source.includes('${POSIX_SHELL ? POSIX_PATH : \'\'}gh'), 'GH must be platform-gated')
  assert.ok(source.includes('${POSIX_SHELL ? POSIX_PATH : \'\'}hermes'), 'HERMES must be platform-gated')
})

test('shell: every shell.exec goes through the shellCommand wrapper', () => {
  // A raw `host.request('shell.exec', { command: cmd })` call site bypasses the
  // Windows bash hop and reintroduces the cmd.exe bug for that one query.
  const calls = source.split('\n').filter(line => line.includes("host.request('shell.exec', { command:"))
  assert.ok(calls.length >= 4, 'expected the wrapper callers, the where-git probe and the bash probe')
  for (const call of calls) {
    const ok =
      call.includes('shellCommand(') ||
      call.includes('GITHERMES_SHELL_%OS%') ||
      call.includes("'where git'") ||
      call.includes("'where bash'") ||
      call.includes('for %G in') ||
      call.includes('uname -s')
    assert.ok(ok, `unwrapped shell.exec call site: ${call}`)
  }
  // cmd.exe parses the whole command string (no \" handling; |>&^% are live), so user
  // text may only cross it as base64. bash decodes into an mktemp file and removes
  // it with unlink; inner double quotes would break cmd.exe argv quoting.
  assert.ok(!source.includes('echo ${cmd}'), 'raw command text must not cross cmd.exe')
  assert.doesNotMatch(source, /gt\$\$/, 'predictable PID temp names must not remain')
  assert.doesNotMatch(source, /base64 -d \| bash/, 'decoded output must not be piped into a shell')
  assert.match(source, /mktemp \\\$\{TMPDIR:-\/tmp\}\/gt\.XXXXXX/, 'temp scripts must be created with mktemp')
  assert.match(source, /trap 'unlink \$f 2>\/dev\/null \|\| true' EXIT INT TERM/, 'cleanup must be an unlink trap, including on error')
  assert.match(source, /chmod 600 \$f/, 'temp scripts must be mode 600')
})

test('shell: Windows routes through Git bash, not WSL bash', () => {
  // Windows ships WSL's bash.exe in System32; invoking it would run the command
  // against a different filesystem with no `gh` on PATH. Resolve bash from the
  // installed Git instead of trusting PATH.
  assert.ok(source.includes('function resolveBash'), 'resolveBash is missing')
  assert.ok(source.includes('command: \'where git\''), 'bash must be derived from the git install')
  assert.ok(source.includes("git.replace(/\\\\/g, '/')"), 'Windows paths must be normalized before parsing')
  assert.ok(source.includes('(?:cmd|bin|mingw64\\/bin|usr\\/bin)'), 'all Git-for-Windows install layouts must resolve')
  assert.ok(source.includes('%LOCALAPPDATA%\\\\Programs\\\\Git\\\\bin\\\\bash.exe'), 'expected per-user Git-for-Windows bash candidate')
  assert.ok(!/const BASH = '[A-Z]:/.test(source), 'bash path must not be hardcoded to a drive letter')
  // The first command must wait for the Git-for-Windows probe; it must never
  // race into bare `bash` and accidentally launch System32's WSL shim.
  assert.ok(source.includes('let bashReady = null'), 'bash resolution must be shared')
  assert.ok(source.includes('await resolveBash()'), 'shell commands must await bash resolution')
  assert.ok(source.includes("Git for Windows bash.exe was not found"), 'missing Git Bash needs a clear recovery error')
})

test('shell: bash is resolved once at registration', () => {
  const register = source.slice(source.indexOf('register(ctx) {'))
  assert.ok(register.includes('resolveBash()'), 'register must start bash resolution')
})
