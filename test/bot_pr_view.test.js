import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../desktop/plugin.js'
const { dependencyBotPr, parseDependencyTitle, groupDependencyPrs, requestDependencyBotRebase } = plugin
const commits = date => JSON.stringify([[{ commit: { committer: { date } } }]])

const pr = (overrides = {}) => ({
  repo: 'owner/repo', number: 1, title: 'Update dependency @angular/router from 22.1.0 to 22.2.0',
  author: { login: 'renovate[bot]' }, headRefName: 'renovate/angular-router-22.x',
  state: 'OPEN', isDraft: false, mergeableState: 'clean', checkState: 'SUCCESS',
  ...overrides,
})

test('dependency bot detection recognizes known/configured logins and self-hosted branch prefixes', () => {
  assert.equal(dependencyBotPr(pr()), true)
  assert.equal(dependencyBotPr(pr({ author: { login: 'dependabot[bot]' }, headRefName: 'feature/deps' })), true)
  assert.equal(dependencyBotPr(pr({ author: { login: 'automation-user' }, headRefName: 'feature/deps' }), { logins: ['automation-user'] }), true)
  assert.equal(dependencyBotPr(pr({ author: { login: 'alice' }, headRefName: 'renovate/custom-update' })), true)
  assert.equal(dependencyBotPr(pr({ author: { login: 'alice' }, headRefName: 'dependabot/npm_and_yarn/pkg-1.2.3' })), true)
  assert.equal(dependencyBotPr(pr({ author: { login: 'alice' }, headRefName: 'feature/renovate/custom-update' })), false)
  assert.equal(dependencyBotPr(pr({ author: { login: 'alice' }, headRefName: 'feature/update' })), false)
})

test('dependency title parser extracts package, version jump, major and security markers', () => {
  assert.deepEqual(parseDependencyTitle('Update dependency @angular/router from 22.1.0 to 23.0.0'), {
    package: '@angular/router', from: '22.1.0', to: '23.0.0', major: true, security: false,
  })
  assert.equal(parseDependencyTitle('Update dependency react from 1.4.0 to v2.0.0').major, true)
  assert.equal(parseDependencyTitle('Update dependency react from 2.0.0 to v1.4.0').major, false)
  assert.equal(parseDependencyTitle('Update dependency react from 1.4.0 to 1.5.0 (major)').major, true)
  assert.deepEqual(parseDependencyTitle('[SECURITY] Bump lodash from 4.17.20 to 4.17.21'), {
    package: 'lodash', from: '4.17.20', to: '4.17.21', major: false, security: true,
  })
  assert.deepEqual(parseDependencyTitle('chore(deps): update dependency @types/node to v22.10.2'), {
    package: '@types/node', from: null, to: '22.10.2', major: null, security: false,
  })
  assert.equal(parseDependencyTitle('Update dependencies'), null)
})

test('target-only vN without a minor version is major; dotted versions stay unselected', () => {
  assert.equal(parseDependencyTitle('Update dependency react to v19').major, true)
  assert.equal(parseDependencyTitle('Update dependency react to v22.10.2').major, null)
  assert.equal(parseDependencyTitle('Update dependency react to v1.2').major, null)
  assert.equal(parseDependencyTitle('Update dependency react to v1.2.3').major, null)
  assert.equal(parseDependencyTitle('Update dependency react from 18.2.0 to 18.3.0 (major)').major, true)
  assert.equal(parseDependencyTitle('Update dependency react to 19.0.0').major, null)
  assert.deepEqual([...plugin.dependencyMergeSelection([
    { repo: 'o/r', number: 1, dependency: { major: false } },
    { repo: 'o/r', number: 2, dependency: { major: true } },
    { repo: 'o/r', number: 3, dependency: { major: null } },
    { repo: 'o/r', number: 4, dependency: undefined },
    { repo: 'o/r', number: 5, dependency: { major: 'unknown' } },
  ])], ['o/r#1'])
})

test('dependency PRs group green, red, pending and conflicts with conflicts taking precedence', () => {
  const groups = groupDependencyPrs([
    pr({ number: 1 }),
    pr({ number: 2, checkState: 'FAILURE' }),
    pr({ number: 3, checkState: 'PENDING' }),
    pr({ number: 4, mergeableState: 'dirty' }),
    pr({ number: 5, isDraft: true }),
    pr({ number: 6, mergeableState: 'CONFLICTING' }),
    pr({ number: 7, mergeableState: 'UNKNOWN' }),
  ])
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, rows.map(row => row.number)])), {
    green: [1], red: [2], pending: [3, 5, 7], conflict: [4, 6],
  })
})

test('conflict handling requests a bot rebase, never a local rebase, and deduplicates concurrent clicks', async () => {
  const calls = []
  let comments = []
  const run = async command => {
    calls.push(command)
    if (command.includes('pulls/1/commits')) return commits('2025-12-31T00:00:00Z')
    if (command.includes('--paginate')) return JSON.stringify([comments])
    if (command.includes('--method POST')) { comments = [{ body: '@dependabot rebase', created_at: '2026-01-01T00:00:00Z' }]; return '{}' }
    throw new Error('unexpected command')
  }
  const item = pr({ author: { login: 'dependabot[bot]' }, headRefName: 'dependabot/npm_and_yarn/pkg-1' })
  const [first, second] = await Promise.all([requestDependencyBotRebase(item, run), requestDependencyBotRebase(item, run)])
  assert.deepEqual(first, { status: 'requested', command: '@dependabot rebase' })
  assert.deepEqual(second, first)
  assert.equal(calls.filter(command => command.includes('--method POST')).length, 1)
  assert.ok(calls.every(command => !/git\s+rebase|force-with-lease/i.test(command)))
  assert.equal((await requestDependencyBotRebase(item, run)).status, 'already-requested')
})

test('Renovate rebase checks the PR body checkbox without posting a comment', async () => {
  const calls = []
  let body = '## Update\n- [ ] <!-- rebase-check -->'
  const run = async command => {
    calls.push(command)
    if (command.includes('pulls/1/commits')) return commits('2025-12-31T00:00:00Z')
    if (command.includes('pulls/1')) return JSON.stringify({ body, updated_at: '2026-01-01T00:00:00Z' })
    throw new Error(`unexpected command: ${command}`)
  }
  const result = await requestDependencyBotRebase(pr(), run, async (endpoint, data) => {
    calls.push(`PATCH ${endpoint}`)
    assert.equal(endpoint, 'repos/owner/repo/pulls/1')
    body = data.body
  })
  assert.deepEqual(result, { status: 'requested', command: 'PR body rebase checkbox' })
  assert.ok(calls.some(command => command.startsWith('PATCH ')))
  assert.ok(calls.every(command => !command.includes('--method POST') && !command.includes('@renovate')))
  assert.match(body, /- \[x\] <!-- rebase-check -->/)
})

test('a checked Renovate box remains an outstanding request without invented timeline edit data', async () => {
  const calls = []
  let body = '## Update\n- [x] <!-- rebase-check -->'
  let patches = 0
  const run = async command => {
    calls.push(command)
    if (command.includes('pulls/1/commits')) return commits('2025-12-31T00:00:00Z')
    if (command.includes('pulls/1')) return JSON.stringify({ body })
    throw new Error(`unexpected command: ${command}`)
  }
  const result = await requestDependencyBotRebase(pr(), run, async () => { patches++ })
  assert.deepEqual(result, { status: 'already-requested', command: 'PR body rebase checkbox' })
  assert.equal(patches, 0)
  assert.ok(calls.every(command => !command.includes('/timeline')))
  assert.match(body, /- \[x\] <!-- rebase-check -->/)
})

test('an existing rebase request is stale when it predates the latest head commit', async () => {
  const calls = []
  let comments = [{ body: '@dependabot rebase', created_at: '2025-12-30T00:00:00Z' }]
  const run = async command => {
    calls.push(command)
    if (command.includes('pulls/1/commits')) return commits('2025-12-31T00:00:00Z')
    if (command.includes('--paginate')) return JSON.stringify([comments])
    if (command.includes('--method POST')) { comments = [{ body: '@dependabot rebase', created_at: '2026-01-01T00:00:00Z' }]; return '{}' }
    throw new Error(`unexpected command: ${command}`)
  }
  const result = await requestDependencyBotRebase(pr({ author: { login: 'dependabot[bot]' }, headRefName: 'dependabot/update' }), run)
  assert.equal(result.status, 'requested')
  assert.ok(calls.some(command => command.includes('--method POST')))
})

test('malformed pagination prevents a dependency bot mutation', async () => {
  const item = pr({ author: { login: 'dependabot[bot]' }, headRefName: 'dependabot/update' })
  for (const response of [{ message: 'not pages' }, [null], [[{ unexpected: true }]]]) {
    const calls = []
    await assert.rejects(requestDependencyBotRebase(item, async command => {
      calls.push(command)
      return JSON.stringify(response)
    }))
    assert.ok(calls.every(command => !command.includes('--method POST')))
  }
})
