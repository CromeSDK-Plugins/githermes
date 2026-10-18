import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildIssueDraftBody,
  confirmedIssueWrite,
  detectIssueDraftCandidate,
  duplicateSearchQuery,
  issueDraftRepoFromText,
  issueDraftRepoFromMessages,
  issueDraftTitle,
  parseIssueDraftResponse,
  issueBodyDiff,
  issueDraftFinalBody,
  rewriteIssueBody,
  redactIssueSecrets,
  resolveIssueDraftRepo,
} from '../desktop/plugin.js'

test('repo selection prefers the session repository, accepts an explicit chat repo, and rejects ambiguous input', () => {
  assert.equal(resolveIssueDraftRepo({ sessionRepo: 'owner/session', chatRepo: 'owner/chat' }), 'owner/session')
  assert.equal(resolveIssueDraftRepo({ chatRepo: 'other/repo' }), 'other/repo')
  assert.equal(resolveIssueDraftRepo({ sessionRepo: 'bad; gh issue create', chatRepo: '' }), '')
  assert.equal(issueDraftRepoFromText('See https://github.com/CromeSDK-Plugins/githermes/issues/13'), 'CromeSDK-Plugins/githermes')
  assert.equal(issueDraftRepoFromText('See https://github.com/other/project/pull/42'), 'other/project')
  assert.equal(resolveIssueDraftRepo({ chatRepo: issueDraftRepoFromText('See https://github.com/other/project/pull/42') }), 'other/project')
  assert.equal(issueDraftRepoFromText('There is no repository here'), '')
  assert.equal(issueDraftRepoFromText('and/or'), '')
  assert.equal(issueDraftRepoFromText('src/foo'), '')
  assert.equal(issueDraftRepoFromText('See https://github.com/CromeSDK-Plugins/githermes/issues/13.'), 'CromeSDK-Plugins/githermes')
  assert.equal(issueDraftRepoFromText('owner/repository'), 'owner/repository')
  assert.equal(issueDraftRepoFromText('Repository: owner/repository'), 'owner/repository')
})

test('chat repo resolution selects the newest explicit repository mention', () => {
  assert.equal(issueDraftRepoFromMessages([
    { role: 'user', content: 'Use https://github.com/older/repo for this.' },
    { role: 'assistant', content: 'The latest request is for https://github.com/newer/repo.' },
  ]), 'newer/repo')
})

test('chat repo resolution leaves same-message ties unresolved for the user', () => {
  assert.equal(issueDraftRepoFromMessages([
    { role: 'user', content: 'Please use https://github.com/one/repo and https://github.com/two/repo.' },
  ]), '')
})

test('chat repo resolution rejects slash-shaped prose, paths, and dates without losing explicit repositories', () => {
  for (const text of [
    'TCP/IP is enabled.',
    'Choose one and/or the other.',
    'I/O is configured.',
    'Measure speed in km/h.',
    'See src/foo for the implementation.',
    'The file is ./owner/repo/config.json.',
    'The checkout is C:/Users/alice/project.',
    'Release date: 2026/10/15.',
  ]) {
    assert.equal(issueDraftRepoFromMessages([{ role: 'user', content: text }]), '', text)
  }
  assert.equal(issueDraftRepoFromMessages([{ role: 'user', content: 'Use owner/repository for this.' }]), 'owner/repository')
  assert.equal(issueDraftRepoFromMessages([{ role: 'user', content: 'Use https://github.com/owner/repository/issues/2.' }]), 'owner/repository')
})

test('duplicate search is scoped to open issues and title/body; body rewrite diff shows additions and removals', () => {
  assert.equal(duplicateSearchQuery('Keyboard bug', 'Focus lost'), 'is:issue is:open in:title,body Keyboard bug Focus lost')
  assert.equal(issueBodyDiff('old heading\nold detail\nkeep', 'new heading\nnew detail\nkeep'), '- old heading\n- old detail\n+ new heading\n+ new detail\n  keep')
  assert.equal(rewriteIssueBody('Existing scope', 'New session context'), 'Existing scope\n\n<!-- githermes:issue-draft:start -->\nNew session context\n<!-- githermes:issue-draft:end -->')
  assert.equal(rewriteIssueBody('Before\n\n<!-- githermes:issue-draft:start -->\nOld draft\n<!-- githermes:issue-draft:end -->\n\nAfter', 'New draft'), 'Before\n\n<!-- githermes:issue-draft:start -->\nNew draft\n<!-- githermes:issue-draft:end -->\n\nAfter')
})

test('Issue #13 R4: duplicate update preview and write use the same final body', async () => {
  const cases = [
    { name: 'without markers', existing: 'Existing scope', draft: 'Draft content', expected: 'Existing scope\n\n<!-- githermes:issue-draft:start -->\nDraft content\n<!-- githermes:issue-draft:end -->' },
    { name: 'with markers', existing: 'Before\n\n<!-- githermes:issue-draft:start -->\nOld draft\n<!-- githermes:issue-draft:end -->\n\nAfter', draft: 'Draft content', expected: 'Before\n\n<!-- githermes:issue-draft:start -->\nDraft content\n<!-- githermes:issue-draft:end -->\n\nAfter' },
  ]

  for (const { name, existing, draft, expected } of cases) {
    const finalBody = issueDraftFinalBody({ body: existing }, draft)
    assert.equal(finalBody, expected, name)
    const calls = []
    let stored = { number: 7, title: 'Existing', body: existing }
    await confirmedIssueWrite({
      action: 'update', confirmed: true, repo: 'owner/repo', title: 'Existing', body: finalBody,
      number: 7, originalTitle: 'Existing', originalBody: existing,
      readIssue: async () => ({ ...stored }),
      updateIssue: async (_repo, _number, _title, body) => { calls.push(body); stored.body = body },
    })
    assert.equal(issueBodyDiff(existing, finalBody), issueBodyDiff(existing, calls[0]), `${name}: reviewed diff must match written body`)
    assert.equal(calls[0], finalBody, `${name}: exact reviewed body must be written`)
  }
})

test('duplicate update normalizes CRLF and LF bodies to the same reviewed diff and written LF body', async () => {
  const lfExisting = 'Before\n\n<!-- githermes:issue-draft:start -->\nOld draft\n<!-- githermes:issue-draft:end -->\n\nAfter'
  const cr = String.fromCharCode(13)
  const crlfExisting = lfExisting.replaceAll('\n', `${cr}\n`)
  const expected = 'Before\n\n<!-- githermes:issue-draft:start -->\nNew draft\n<!-- githermes:issue-draft:end -->\n\nAfter'
  const results = []

  for (const existing of [lfExisting, crlfExisting]) {
    const finalBody = issueDraftFinalBody({ body: existing }, 'New draft')
    const calls = []
    let stored = { number: 7, title: 'Existing', body: existing }
    await confirmedIssueWrite({
      action: 'update', confirmed: true, repo: 'owner/repo', title: 'Existing', body: finalBody,
      number: 7, originalTitle: 'Existing', originalBody: existing,
      readIssue: async () => ({ ...stored }),
      updateIssue: async (_repo, _number, _title, body) => { calls.push(body); stored.body = body },
    })
    assert.equal(finalBody, expected)
    assert.equal(calls[0].includes(cr), false)
    assert.equal(issueBodyDiff(existing, finalBody), issueBodyDiff(existing.split(cr).join(''), expected))
    assert.equal(calls[0], finalBody)
    results.push({ diff: issueBodyDiff(existing, finalBody), body: calls[0] })
  }
  assert.deepEqual(results[0], results[1])
})

test('Issue #13 R4: switching duplicate selection replaces A context with B context', () => {
  const draftContent = 'Draft content'
  const bodyA = issueDraftFinalBody({ body: 'Existing issue A' }, draftContent)
  const bodyB = issueDraftFinalBody({ body: 'Existing issue B' }, draftContent)
  assert.match(bodyA, /Existing issue A/)
  assert.match(bodyB, /Existing issue B/)
  assert.doesNotMatch(bodyB, /Existing issue A/)
  assert.equal(bodyB, 'Existing issue B\n\n<!-- githermes:issue-draft:start -->\nDraft content\n<!-- githermes:issue-draft:end -->')
})

test('duplicate search uses task content, finds a matching issue fixture, and omits template boilerplate', () => {
  const title = 'Keep issue draft in the active Hermes session'
  const body = buildIssueDraftBody({
    goal: 'Persist a session issue draft after a model response',
    context: 'The pane currently loses the proposed title and body.',
    implementation: 'Read assistant history and populate the form once.',
    acceptance: ['The returned draft appears without copy and paste.'],
  })
  const query = duplicateSearchQuery(title, body)
  const fixture = { title, body: 'Persist a session issue draft after a model response. The pane currently loses the proposed title and body. Read assistant history and populate the form once. The returned draft appears without copy and paste.', state: 'OPEN' }
  const terms = query.replace(/^is:issue is:open in:title,body\s*/, '').toLowerCase().split(/\s+/).filter(Boolean)
  assert.ok(terms.length > 0)
  const matches = [fixture].filter(issue => issue.state === 'OPEN' && terms.every(term => `${issue.title} ${issue.body}`.toLowerCase().includes(term)))
  assert.deepEqual(matches, [fixture], `matching open-issue fixture not found for terms: ${terms.join(', ')}`)
  for (const boilerplate of ['## Goal', '## Context', '## Implementation', '## Acceptance criteria', '## References', 'Describe the desired outcome', 'Add relevant session context', 'Add relevant session, PR, or issue links']) {
    assert.ok(!query.includes(boilerplate), `query contains template boilerplate: ${boilerplate}`)
  }
  assert.equal(duplicateSearchQuery('Useful title', buildIssueDraftBody({})), 'is:issue is:open in:title,body Useful title')
})

test('assistant issue draft response is parsed into title and body for direct form adoption', () => {
  assert.deepEqual(parseIssueDraftResponse([
    { role: 'user', text: 'Draft an issue' },
    { role: 'assistant', text: 'Title: Preserve the issue draft\n\nBody:\n## Goal\nKeep the proposed issue in the pane.\n\n## Acceptance criteria\n- [ ] No copy and paste' },
  ]), {
    title: 'Preserve the issue draft',
    body: '## Goal\nKeep the proposed issue in the pane.\n\n## Acceptance criteria\n- [ ] No copy and paste',
  })
  assert.equal(parseIssueDraftResponse([
    { role: 'assistant', text: 'Title: Old draft\n\nBody:\nOld body' },
    { role: 'user', text: 'Draft a GitHub issue from this session' },
  ]), null, 'a previous answer must not populate the form while the current request is unanswered')
})

test('issue draft form always starts with a non-empty, secret-masked title', () => {
  assert.equal(issueDraftTitle('Follow-up: keep the session draft'), 'Follow-up: keep the session draft')
  assert.equal(issueDraftTitle('token=super-secret-value-12345'), 'token=[REDACTED]')
  assert.equal(issueDraftTitle(''), 'Session issue draft')
})

test('duplicate issue title is redacted before it can be adopted into the form', () => {
  const item = { title: 'Investigate token=super-secret-value-12345' }
  assert.equal(redactIssueSecrets(item.title), 'Investigate token=[REDACTED]')
})

test('draft bodies use the required sections and secret-shaped values are masked before review', () => {
  const body = buildIssueDraftBody({ goal: 'Use ghp_12345678901234567890 in a sample' })
  assert.match(body, /## Goal[\s\S]*## Context[\s\S]*## Implementation[\s\S]*## Acceptance criteria[\s\S]*## References/)
  assert.equal(redactIssueSecrets('token=super-secret-value-12345'), 'token=[REDACTED]')
  assert.equal(redactIssueSecrets('ghp_12345678901234567890'), '[REDACTED]')
})

test('auto-detection only suggests explicitly marked issue intent and masks secrets', () => {
  assert.equal(detectIssueDraftCandidate([{ role: 'user', content: 'We should track this as an issue: token=super-secret-value-12345' }]), 'We should track this as an issue: token=[REDACTED]')
  assert.equal(detectIssueDraftCandidate([{ role: 'user', content: 'Maybe someday we can improve this' }]), null)
})

test('GitHub writes require explicit confirmation, update checks the reviewed body and both paths read back exact values', async () => {
  const calls = []
  let stored = { number: 7, title: 'Old', body: 'before', url: 'https://github.com/a/b/issues/7' }
  const api = {
    readIssue: async () => ({ ...stored }),
    createIssue: async (_repo, title, body) => { calls.push('create'); stored = { number: 8, title, body, url: 'https://github.com/a/b/issues/8' }; return stored },
    updateIssue: async (_repo, _number, title, body) => { calls.push('update'); stored = { ...stored, title, body } },
  }
  await assert.rejects(confirmedIssueWrite({ action: 'create', confirmed: false, repo: 'a/b', title: 'New', body: 'draft', ...api }), /explicit confirmation/)
  assert.deepEqual(calls, [])
  const created = await confirmedIssueWrite({ action: 'create', confirmed: true, repo: 'a/b', title: 'New', body: 'draft', ...api })
  assert.equal(created.title, 'New')
  assert.equal(calls[0], 'create')
  stored = { number: 7, title: 'Old', body: 'before', url: 'https://github.com/a/b/issues/7' }
  const updated = await confirmedIssueWrite({ action: 'update', confirmed: true, repo: 'a/b', title: 'Rewritten', body: 'after', number: 7, originalTitle: 'Old', originalBody: 'before', ...api })
  assert.equal(updated.body, 'after')
  await assert.rejects(confirmedIssueWrite({ action: 'update', confirmed: true, repo: 'a/b', title: 'Lost edit', body: 'after', number: 7, originalTitle: 'Old', originalBody: 'stale', ...api }), /changed since review/)
  assert.equal(calls.filter(call => call === 'update').length, 1)
})

test('redactIssueSecrets masks supported credential forms recursively and leaves ordinary text unchanged', () => {
  const privateKey = ['-----BEGIN RSA PRIVATE KEY-----', 'private-key-material', '-----END RSA PRIVATE KEY-----'].join('\\n')
  const input = {
    title: 'Deploy token=super-secret-value-12345',
    body: [
      'ghp_1234567890abcdefghijklmnopqrstuv',
      'AKIA1234567890ABCDEF',
      'eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.signature',
      'Authorization: Bearer very-secret-bearer-value',
      'https://alice:password@example.com/path?access_token=secret-value',
      privateKey,
      'ordinary issue text and owner/repository stay readable',
    ],
  }
  const redacted = redactIssueSecrets(input)
  assert.equal(redacted.title, 'Deploy token=[REDACTED]')
  assert.equal(redacted.body[0], '[REDACTED]')
  assert.equal(redacted.body[1], '[REDACTED]')
  assert.equal(redacted.body[2], '[REDACTED JWT]')
  assert.equal(redacted.body[3], 'Authorization: [REDACTED]')
  assert.equal(redacted.body[4], 'https://[REDACTED]@example.com/path?access_token=[REDACTED]')
  assert.equal(redacted.body[5], '[REDACTED PRIVATE KEY]')
  assert.equal(redacted.body[6], input.body[6])
})

test('duplicate title and body are both masked before update review and write', async () => {
  const duplicate = {
    title: 'Fix token=title-secret-value-12345',
    body: 'Existing context password=body-secret-value-12345\nKeep this older context.',
  }
  const reviewedTitle = redactIssueSecrets(duplicate.title)
  const reviewedBody = issueDraftFinalBody(duplicate, 'New content token=draft-secret-value-12345')
  assert.equal(reviewedTitle, 'Fix token=[REDACTED]')
  assert.ok(reviewedBody.includes('password=[REDACTED]'))
  assert.ok(reviewedBody.includes('Keep this older context.'))
  assert.ok(reviewedBody.includes('token=[REDACTED]'))
  assert.ok(![reviewedTitle, reviewedBody].join('\n').includes('secret-value'))

  let storedTitle = duplicate.title
  let storedBody = duplicate.body
  let writtenBody = ''
  await confirmedIssueWrite({
    action: 'update', confirmed: true, repo: 'owner/repo', title: reviewedTitle, body: reviewedBody,
    number: 7, originalTitle: duplicate.title, originalBody: duplicate.body,
    readIssue: async () => ({ number: 7, title: storedTitle, body: storedBody, state: 'OPEN' }),
    updateIssue: async (_repo, _number, title, body) => { storedTitle = title; writtenBody = body; storedBody = body },
  })
  assert.equal(writtenBody, reviewedBody)
  assert.ok(writtenBody.includes('password=[REDACTED]'))
  assert.ok(writtenBody.includes('Keep this older context.'))
  assert.ok(!writtenBody.includes('body-secret-value'))
})
