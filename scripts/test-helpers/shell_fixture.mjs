import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let bashPath
export function fixtureBash() {
  if (bashPath) return bashPath
  if (process.platform !== 'win32') return '/bin/bash'
  const candidates = []
  const where = name => {
    try { return execFileSync('where.exe', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\r?\n/) }
    catch { return [] }
  }
  for (const git of where('git')) {
    const match = git.replace(/\\/g, '/').match(/^(.*)\/(?:cmd|bin|mingw64\/bin|usr\/bin)\/git\.exe$/i)
    if (match) candidates.push(`${match[1]}/bin/bash.exe`, `${match[1]}/usr/bin/bash.exe`)
  }
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean)) {
    candidates.push(join(root, 'Git', 'bin', 'bash.exe'))
  }
  candidates.push(...where('bash'))
  for (const candidate of [...new Set(candidates)]) {
    if (!existsSync(candidate) || /[\\/](?:System32|SysWOW64|WindowsApps)[\\/]/i.test(candidate)) continue
    try {
      const output = execFileSync(candidate, ['-c', 'uname -s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      if (/^(?:MINGW|MSYS)/.test(output.trim())) return (bashPath = candidate)
    } catch { /* Try the next installed Git Bash. */ }
  }
  throw new Error('Transport tests require a working Git for Windows Bash; PATH entries for WSL are not usable.')
}

// Test-only relocation at the real shell RPC seam.
export function relocateShellArtifacts(command, fixtureRoot) {
  // Relocate only the shipped transport's artifacts, never fixture payloads
  // whose absolute Linux paths may already start with /tmp/.
  return command.replace(/\/tmp\/(?=(?:ghprs\.|ghaggregate\.|ghfix\.|gt\$\$\.sh))/g, `${fixtureRoot}/`)
}
