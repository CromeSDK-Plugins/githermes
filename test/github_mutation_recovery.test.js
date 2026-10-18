import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as plugin from '../desktop/plugin.js'

const issue = { number: 12, title: 'New issue', body: 'Reviewed body', state: 'OPEN', url: 'https://github.com/owner/repo/issues/12' }
const base = { action: 'create', confirmed: true, repo: 'owner/repo', title: issue.title, body: issue.body }

test('accepted issue identity is retained before readback and accompanies a failed verification', async () => {
  const calls = [], receipts = []
  await assert.rejects(plugin.confirmedIssueWrite({
    ...base,
    createIssue: async () => { calls.push('create'); return issue },
    onCreated: created => { calls.push('receipt'); receipts.push(created) },
    readIssue: async (_repo, number) => { calls.push(`read:${number}`); throw new Error('readback unavailable') },
  }), error => {
    assert.match(error.message, /readback unavailable/)
    assert.equal(error.created.number, issue.number)
    return true
  })
  assert.deepEqual(calls, ['create', 'receipt', 'read:12'])
  assert.equal(receipts[0].url, issue.url)
})

test('an accepted create remains identifiable when receipt persistence fails', async () => {
  let posts = 0, reads = 0
  await assert.rejects(plugin.confirmedIssueWrite({
    ...base,
    createIssue: async () => { posts++; return issue },
    onCreated: () => { throw new Error('storage unavailable') },
    readIssue: async () => { reads++; return issue },
  }), error => {
    assert.match(error.message, /storage unavailable/)
    assert.equal(error.created.number, issue.number)
    return true
  })
  assert.equal(posts, 1)
  assert.equal(reads, 0)
})

test('an uncertain create is not automatically repeated and has no invented issue identity', async () => {
  let posts = 0, receipts = 0, reads = 0
  await assert.rejects(plugin.confirmedIssueWrite({
    ...base,
    createIssue: async () => { posts++; throw new Error('connection lost after POST') },
    onCreated: () => { receipts++ },
    readIssue: async () => { reads++; return issue },
  }), /connection lost after POST/)
  assert.deepEqual({ posts, receipts, reads }, { posts: 1, receipts: 0, reads: 0 })
})

test('a mismatched create readback reports the existing issue instead of losing its identity', async () => {
  await assert.rejects(plugin.confirmedIssueWrite({
    ...base, createIssue: async () => issue,
    readIssue: async () => ({ ...issue, body: 'Someone edited this after creation' }),
  }), error => {
    assert.match(error.message, /did not match/)
    assert.equal(error.created.number, issue.number)
    return true
  })
})

const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
const start = source.indexOf('function IssueDraftPanel(')
const panelSource = source.slice(start, source.indexOf('\n}', start) + 2)

function panelFixture({ data = new Map(), requests = { posts: 0, reads: 0 }, failRead = () => true, failPost = false, failStorage = false, recheckMatches = () => [], switchAfterPost = false, switchAfterRead = false, duplicateIssue = null } = {}) {
  const slots = []
  const routes = []
  let backend = 'original'
  let writtenBody = duplicateIssue?.body || issue.body
  let cursor = 0
  const state = initial => {
    const index = cursor++
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
  }
  const storage = {
    get: (key, fallback) => data.has(key) ? data.get(key) : fallback,
    set: (key, value) => { if (typeof failStorage === 'function' ? failStorage(key, value) : failStorage) throw new Error('storage unavailable'); data.set(key, structuredClone(value)) },
  }
  const deps = {
    ...plugin,
    useState: state, useRef: initial => state(() => ({ current: initial }))[0], useEffect: () => {},
    useMemo: callback => callback(),
    jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }),
    Button: 'button', Input: 'input', Textarea: 'textarea',
    cn: (...parts) => parts.filter(Boolean).join(' '),
    pluginCtx: { storage },
    host: { state: { connectionId: { get: () => 'local' }, profile: { get: () => 'default' } } },
    queryClient: { invalidateQueries: async () => {} }, insertComposerText: () => {},
    captureShell: () => ({ backend }),
    ID: 'githermes', GH: 'gh',
    shJsonBig: async (command, options) => {
      if (command.includes('issue list') && command.includes('--state all')) {
        assert.doesNotMatch(command, /is:open/, 'reconciliation must include already closed issues')
        return recheckMatches()
      }
      if (command.includes('issue list')) return duplicateIssue ? [duplicateIssue] : []
      if (command.includes('issue view')) {
        routes.push(options?.context?.backend || backend)
        requests.reads++
        if (failRead()) throw new Error('readback unavailable')
        if (switchAfterRead) backend = 'new-active'
        return { ...issue, body: writtenBody }
      }
      throw new Error(`unexpected read ${command}`)
    },
    writeGithubJson: async (endpoint, method, payload, context) => {
      assert.equal(endpoint, `repos/owner/repo/issues${duplicateIssue ? '/12' : ''}`)
      assert.equal(method, duplicateIssue ? 'PATCH' : 'POST')
      assert.deepEqual(payload, { title: issue.title, body: duplicateIssue ? plugin.issueDraftFinalBody(duplicateIssue, issue.body) : issue.body })
      requests.posts++
      routes.push(context?.backend || backend)
      if (switchAfterPost) backend = 'new-active'
      if (failPost) throw Object.assign(new Error(typeof failPost === 'string' ? failPost : 'connection lost after POST'), typeof failPost === 'string' ? { exitCode: 1 } : {})
      writtenBody = payload.body
      return { ...issue, body: writtenBody, url: 'https://api.github.com/repos/owner/repo/issues/12', html_url: issue.url }
    },
  }
  const Panel = new Function('deps', `with (deps) { ${panelSource}; return IssueDraftPanel }`)(deps)
  let tree
  const render = () => { cursor = 0; tree = Panel({ sessionRepo: 'owner/repo', chatMessages: [], candidate: '', onBack: () => {} }); return tree }
  const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
  const find = predicate => nodes(tree).find(predicate)
  const button = label => {
    const match = find(node => node.type === 'button' && node.props?.children === label)
    assert.ok(match, `button not found: ${label}`)
    return match.props
  }
  const setField = (label, value) => {
    const field = find(node => node.props?.['aria-label'] === label)
    assert.ok(field, `field not found: ${label}`)
    field.props.onChange({ target: { value } }); render()
  }
  const prepare = async () => {
    render(); setField('Issue title', issue.title); setField('Issue body', issue.body)
    await button('Check duplicates').onClick(); render()
  }
  const selectDuplicate = () => {
    const row = find(node => node.type === 'button' && Array.isArray(node.props?.children) && String(node.props.children[0]?.props?.children || '').startsWith('owner/repo#12 '))
    assert.ok(row, 'duplicate issue selection missing')
    row.props.onClick(); render()
  }
  return { render, button, prepare, data, requests, routes, selectDuplicate, acknowledge: () => { find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({target:{checked:true}}); render() }, links: () => nodes(tree).filter(node => node.type === 'a').map(node => node.props.href) }
}

test('an unverified issue creation stays blocked after remount and recovery only reads the accepted number', async () => {
  let readFails = true
  const fixture = panelFixture({ failRead: () => readFails })
  await fixture.prepare()
  assert.equal(fixture.button('Anlegen').disabled, false)
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.button('Anlegen').disabled, true)
  assert.ok(fixture.links().includes(issue.url), 'accepted issue must link to its HTML page, not the REST endpoint')
  const remount = panelFixture({ data: fixture.data, requests: fixture.requests, failRead: () => readFails })
  remount.render()
  assert.equal(remount.button('Anlegen').disabled, true)
  readFails = false
  await remount.button('Ergebnis erneut prüfen').onClick(); remount.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.requests.reads, 2)
})

test('an uncertain POST remains blocked across panel remounts', async () => {
  const fixture = panelFixture({ failPost: true })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.button('Anlegen').disabled, true)
  const remount = panelFixture({ data: fixture.data, requests: fixture.requests })
  remount.render()
  assert.equal(remount.button('Anlegen').disabled, true)
  assert.equal(fixture.requests.posts, 1)
})

test('receipt storage failure prevents issue creation before the POST is sent', async () => {
  const fixture = panelFixture({ failStorage: true })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 0)
})

test('uncertain create recovery can find an issue that has already been closed and never sends a second POST', async () => {
  const fixture = panelFixture({ failPost: true, failRead: () => false, recheckMatches: () => [{ ...issue, state: 'CLOSED' }] })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  await fixture.button('Ergebnis erneut prüfen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.requests.reads, 1)
  assert.ok(fixture.links().includes(issue.url))
})

test('definite authentication rejection clears the create receipt and permits an explicit retry', async () => {
  const fixture = panelFixture({ failPost: 'gh: Bad credentials (HTTP 401)' })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.button('Anlegen').disabled, false)
  assert.equal(fixture.data.get('issueDraftWrite'), null)
  const remount = panelFixture({ data: fixture.data, requests: fixture.requests })
  await remount.prepare()
  assert.equal(remount.button('Anlegen').disabled, false)
  assert.equal(fixture.requests.posts, 1, 'clearing a rejected receipt must not replay the POST')
})

test('failed created-receipt persistence keeps the accepted issue visible and recoverable in the current panel', async () => {
  const fixture = panelFixture({ failStorage: (_key, value) => value?.stage === 'created', failRead: () => false })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.requests.reads, 0)
  assert.equal(fixture.data.get('issueDraftWrite').stage, 'sending')
  assert.equal(fixture.button('Anlegen').disabled, true)
  assert.ok(fixture.links().includes(issue.url))
  await fixture.button('Ergebnis erneut prüfen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.requests.reads, 1)
  assert.equal(fixture.data.get('issueDraftWrite'), null)
})

test('a server error after a possibly accepted POST retains the durable ambiguity barrier', async () => {
  const fixture = panelFixture({ failPost: 'gh: Internal Server Error (HTTP 500)' })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.button('Anlegen').disabled, true)
  assert.equal(fixture.data.get('issueDraftWrite').stage, 'sending')
})

test('issue creation and readback remain on the initiating backend after the active profile changes', async () => {
  const fixture = panelFixture({ switchAfterPost: true, failRead: () => false })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.deepEqual(fixture.routes, ['original', 'original'])
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.requests.reads, 1)
})

test('an issue update retains its backend between preflight, PATCH and readback', async () => {
  const fixture = panelFixture({ switchAfterRead: true, failRead: () => false, duplicateIssue: { ...issue, body: 'Previous reviewed context' } })
  await fixture.prepare(); fixture.selectDuplicate()
  await fixture.button('Aktualisieren').onClick(); fixture.render()
  assert.deepEqual(fixture.routes, ['original', 'original', 'original'])
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.requests.reads, 2)
})

test('manual recovery requires an explicit GitHub check and only unlocks a new review', async () => {
  const fixture = panelFixture({ failPost: true })
  await fixture.prepare()
  await fixture.button('Anlegen').onClick(); fixture.render()
  assert.equal(fixture.button('Neuen Versuch freigeben').disabled, true)
  fixture.acknowledge()
  assert.equal(fixture.button('Neuen Versuch freigeben').disabled, false)
  await fixture.button('Neuen Versuch freigeben').onClick(); fixture.render()
  assert.equal(fixture.data.get('issueDraftWrite'), null)
  assert.equal(fixture.requests.posts, 1)
  assert.equal(fixture.button('Anlegen').disabled, true, 'duplicate review must run again before a new write')
})
