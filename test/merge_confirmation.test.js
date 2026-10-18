import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../desktop/plugin.js'

const sha = 'a'.repeat(40)
const options = { repo: 'owner/repo', number: 12, method: 'squash', deleteBranch: true, headSha: sha }
const pull = patch => ({ number: 12, state: 'open', draft: false, head: { sha }, merged: false, ...patch })

test('every merge method binds the confirmed head and returns only a read-back merged PR', async () => {
  for (const method of ['squash', 'merge', 'rebase']) {
    const calls = []
    let reads = 0
    const result = await plugin.mergePullRequest({ ...options, method }, async command => {
      calls.push(['read', command]); reads++
      return pull(reads === 1 ? {} : { state: 'closed', merged: true })
    }, async command => { calls.push(['write', command]) })
    assert.equal(result.merged, true)
    assert.deepEqual(calls.map(([kind]) => kind), ['read', 'write', 'read'])
    const command = calls[1][1]
    assert.match(command, /\bpr merge\b/)
    assert.ok(command.includes(`--${method}`))
    assert.match(command, /--repo\s+'?owner\/repo'?/)
    assert.match(command, new RegExp(`--match-head-commit\\s+'?${sha}'?`))
    assert.match(command, /--delete-branch/)
    assert.doesNotMatch(command, /--admin|--auto\b|--disable-auto/)
    assert.ok(calls.filter(([kind]) => kind === 'read').every(([, read]) => read.includes('repos/owner/repo/pulls/12')))
  }
})

test('a changed head blocks the merge before any mutation', async () => {
  let writes = 0
  await assert.rejects(plugin.mergePullRequest(options, async () => pull({ head: { sha: 'b'.repeat(40) } }), async () => { writes++ }), /head|Head|changed/i)
  assert.equal(writes, 0)
})

test('a successful CLI exit does not report a queued or auto-merge PR as merged', async () => {
  let writes = 0, reads = 0
  await assert.rejects(plugin.mergePullRequest(options, async () => {
    reads++
    return pull(reads === 1 ? {} : { auto_merge: { merge_method: 'SQUASH' } })
  }, async () => { writes++ }), /Merge not confirmed/)
  assert.equal(writes, 1)
  assert.equal(reads, 2)
})

test('a merge mutation or readback failure is never retried automatically', async () => {
  let writes = 0
  await assert.rejects(plugin.mergePullRequest(options, async () => pull(), async () => { writes++; throw new Error('merge transport unavailable') }), /merge transport unavailable/)
  assert.equal(writes, 1)
  let reads = 0
  writes = 0
  await assert.rejects(plugin.mergePullRequest(options, async () => {
    if (++reads > 1) throw new Error('merge readback unavailable')
    return pull()
  }, async () => { writes++ }), /merge readback unavailable/)
  assert.equal(writes, 1)
})

test('merge arguments must identify a valid repository, PR, strategy and reviewed commit', async () => {
  for (const patch of [{ repo: 'owner/repo;bad' }, { number: 0 }, { method: 'admin' }, { headSha: '' }, { headSha: 'main' }]) {
    let calls = 0
    const boundary = async () => { calls++; return pull() }
    await assert.rejects(plugin.mergePullRequest({ ...options, ...patch }, boundary, boundary))
    assert.equal(calls, 0)
  }
})

test('branch deletion remains an explicit merge option', async () => {
  let reads = 0, mutation
  await plugin.mergePullRequest({ ...options, deleteBranch: false }, async () => pull(++reads > 1 ? { merged: true, state: 'closed' } : {}), async command => { mutation = command })
  assert.doesNotMatch(mutation, /--delete-branch/)
})
