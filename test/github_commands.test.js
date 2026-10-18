import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { requestDependencyBotRebase } from '../desktop/plugin.js'

const execFileP = promisify(execFile)
const hasGh = !spawnSync('gh', ['--version'], { windowsHide: true }).error

// Commands are produced by the plugin; only the HTTP destination is replaced.
// This keeps gh's real parser, field conversion, pagination and JSON output.
function shellWords(command) {
  const words = []
  let word = '', quote = '', active = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (quote) {
      if (char === quote) quote = ''
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char; active = true
    } else if (char === '\\') {
      word += command[++i]; active = true
    } else if (/\s/.test(char)) {
      if (active) words.push(word)
      word = ''; active = false
    } else {
      word += char; active = true
    }
  }
  assert.equal(quote, '', 'unterminated shell argument')
  if (active) words.push(word)
  return words
}

async function localGithub(handler, work) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    const url = new URL(request.url, `http://${request.headers.host}`)
    const entry = { method: request.method, url, body: raw ? JSON.parse(raw) : null }
    requests.push(entry)
    response.setHeader('content-type', 'application/json')
    try {
      const result = handler(entry)
      if (result.next) response.setHeader('link', `<${url.origin}${result.next}>; rel="next"`)
      response.statusCode = result.status || 200
      response.end(JSON.stringify(result.data))
    } catch (error) {
      response.statusCode = 500
      response.end(JSON.stringify({ message: error.message }))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const run = async command => {
    const words = shellWords(command)
    const index = words.indexOf('gh')
    assert.ok(index >= 0, `not a gh invocation: ${command}`)
    const args = words.slice(index + 1)
    assert.equal(args[0], 'api')
    const endpoint = args.findIndex(value => value.startsWith('repos/owner/repo/'))
    assert.ok(endpoint > 0, 'every request must target the fixture repository')
    args[endpoint] = `${origin}/${args[endpoint]}`
    const { stdout } = await execFileP('gh', args, {
      windowsHide: true, maxBuffer: 2 ** 20,
      env: { ...process.env, GH_TOKEN: 'synthetic-local-fixture', GH_ENTERPRISE_TOKEN: 'synthetic-local-fixture', GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
    })
    return stdout
  }
  try { await work(run, requests) }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('Dependabot rebase uses real gh-compatible pagination and deduplicates a request on the second page', { skip: !hasGh }, async () => {
  let posted = false
  await localGithub(({ method, url, body }) => {
    if (url.pathname.endsWith('/commits')) {
      return Number(url.searchParams.get('page') || 1) === 1
        ? { data: [{ commit: { committer: { date: '2026-01-01T00:00:00Z' } } }], next: `${url.pathname}?per_page=100&page=2` }
        : { data: [{ commit: { committer: { date: '2026-01-03T00:00:00Z' } } }] }
    }
    if (url.pathname.endsWith('/comments') && method === 'POST') {
      assert.deepEqual(body, { body: '@dependabot rebase' })
      posted = true
      return { status: 201, data: { id: 2, body: '@dependabot rebase', created_at: '2026-01-04T00:00:00Z' } }
    }
    if (url.pathname.endsWith('/comments')) {
      return Number(url.searchParams.get('page') || 1) === 1
        ? { data: [{ id: 1, body: '@dependabot rebase', created_at: '2026-01-02T00:00:00Z' }], next: `${url.pathname}?per_page=100&page=2` }
        : { data: posted ? [{ id: 2, body: '@dependabot rebase', created_at: '2026-01-04T00:00:00Z' }] : [] }
    }
    throw new Error(`unexpected local endpoint ${url.pathname}`)
  }, async (run, requests) => {
    const item = { repo: 'owner/repo', number: 91, author: { login: 'dependabot[bot]' }, headRefName: 'dependabot/npm/package-1' }
    assert.equal((await requestDependencyBotRebase(item, run)).status, 'requested')
    assert.equal((await requestDependencyBotRebase(item, run)).status, 'already-requested')
    assert.equal(requests.filter(request => request.method === 'POST').length, 1)
    assert.ok(requests.some(request => request.url.searchParams.get('page') === '2'))
  })
})

test('an already checked Renovate rebase request needs no unsupported timeline edit events or mutation', { skip: !hasGh }, async () => {
  await localGithub(({ method, url }) => {
    assert.equal(method, 'GET')
    if (url.pathname.endsWith('/commits')) return { data: [{ commit: { committer: { date: '2026-01-03T00:00:00Z' } } }] }
    if (url.pathname.endsWith('/pulls/92')) return { data: { body: '## Update\n- [x] <!-- rebase-check -->' } }
    throw new Error(`unexpected local endpoint ${url.pathname}`)
  }, async (run, requests) => {
    const item = { repo: 'owner/repo', number: 92, author: { login: 'renovate[bot]' }, headRefName: 'renovate/pkg' }
    assert.equal((await requestDependencyBotRebase(item, run)).status, 'already-requested')
    assert.ok(requests.every(request => request.method === 'GET' && !request.url.pathname.endsWith('/timeline')))
  })
})
