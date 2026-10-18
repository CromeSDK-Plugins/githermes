import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { atom, useValue, host, TITLEBAR_AREAS, STATUSBAR_AREAS } from '@hermes/plugin-sdk'
import plugin, { getGitHubShellStore, PLUGIN_REPO } from '../desktop/plugin.js'
import { useState } from 'react'

// Deterministic SDK adapters, not a Desktop/runtime installation test.
test('plugin update checks target the CromeSDK-Plugins repository', () => {
  assert.equal(PLUGIN_REPO, 'CromeSDK-Plugins/githermes')
  assert.ok(PLUGIN_REPO.startsWith('CromeSDK-Plugins/'))

  const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const compareTargets = [...source.matchAll(/repos\/\$\{([^}]+)\}\/compare/g)]
  assert.ok(compareTargets.length > 0, 'expected at least one dynamic compare target')
  for (const [, target] of compareTargets) {
    assert.equal(target, 'PLUGIN_REPO', 'every compare target must use PLUGIN_REPO')
  }

  const literalCompareTargets = [...source.matchAll(/repos\/([^/'"`\s$]+)\/([^/'"`\s$]+)\/compare\b/g)]
  const literalGitHubUrls = [...source.matchAll(/https?:\/\/github\.com\/([^/'"`\s$]+)\/[^'"`\s]*/gi)]
  for (const [, owner] of [...literalCompareTargets, ...literalGitHubUrls]) {
    assert.equal(owner.toLowerCase(), 'cromesdk-plugins', `unexpected GitHub owner: ${owner}`)
  }
})

test('v0.21.7 SDK adapter exposes the real titlebar and statusbar slots', () => {
  assert.deepEqual(TITLEBAR_AREAS, { left: 'titleBar.left', center: 'titleBar.center', right: 'titleBar.right' })
  assert.deepEqual(STATUSBAR_AREAS, { left: 'statusBar.left', right: 'statusBar.right' })
})

test('SDK atom adapter retains state and notifies subscribers', () => {
  const state = atom('initial')
  const seen = []
  const stop = state.subscribe(value => seen.push(value))
  state.set('selected')
  assert.equal(state.get(), 'selected')
  assert.equal(useValue(state), 'selected')
  stop()
  state.set('after-dispose')
  assert.deepEqual(seen, ['initial', 'selected'])
})

test('test adapters initialize lazy state and refuse unconfigured RPCs', async () => {
  let initializations = 0
  const [value] = useState(() => { initializations++; return 'lazy' })
  assert.equal(value, 'lazy')
  assert.equal(initializations, 1)
  await assert.rejects(host.request('shell.exec', { command: 'not-executed' }), /configure host.request explicitly/)
})

test('plugin registration uses valid v0.21.7 contribution slots', () => {
  globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} }
  const contributions = [], disposers = [], storage = new Map([['repo', 'sample-owner/private-project'], ['interceptChatLinks', false]])
  plugin.register({
    register: contribution => { contributions.push(contribution); return () => {} },
    onDispose: fn => disposers.push(fn),
    storage: { get: (key, fallback) => storage.has(key) ? storage.get(key) : fallback, set: (key, value) => storage.set(key, value) },
  })
  try {
    assert.equal(contributions.find(c => c.id === 'titlebar-github').area, 'titleBar.right')
    assert.equal(contributions.find(c => c.id === 'route-github').data.path, '/github')
    assert.equal(contributions.find(c => c.id === 'nav-github').area, 'sidebar.nav')
    for (const c of contributions) assert.equal(typeof c.area, 'string', c.id)
    assert.equal(useValue(host.state.cwd), '')
    assert.equal(useValue(host.state.activeSessionId), null)
    assert.equal(getGitHubShellStore().repo.get(), 'sample-owner/private-project')
    contributions.find(c => c.id === 'palette-chat-links').data.run()
    assert.equal(storage.get('interceptChatLinks'), true)
  } finally { disposers.forEach(fn => fn()) }
})

test('package identity and audited compatibility floor are synchronized', () => {
  const manifest = readFileSync(new URL('../plugin.yaml', import.meta.url), 'utf8')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.equal(pkg.version, '0.6.3')
  assert.match(manifest, /version: "0\.6\.3"/)
  assert.match(manifest, /requires_hermes: ">=0\.21\.7"/)
  assert.match(manifest, /manifest_version: 1/)
  assert.match(manifest, /author: Crome696/)
  assert.match(manifest, /homepage: https:\/\/github.com\/CromeSDK-Plugins\/githermes/)
  assert.equal(pkg.repository.url, 'https://github.com/CromeSDK-Plugins/githermes.git')
  assert.equal(pkg.homepage, 'https://github.com/CromeSDK-Plugins/githermes')
  assert.equal(pkg.bugs.url, 'https://github.com/CromeSDK-Plugins/githermes/issues')
  assert.doesNotMatch(manifest + JSON.stringify(pkg), /Crome696\/githermes/)
  assert.match(readme, /hermes plugins install CromeSDK-Plugins\/githermes --enable/)
  assert.match(readme, /GitHermes \*\*0\.6\.3\*\*/)
  assert.equal(pkg.scripts.pretest, 'node scripts/bootstrap-stubs.mjs')
})
