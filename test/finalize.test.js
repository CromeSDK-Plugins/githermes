import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFinalizeQuery, decodeFinalizeResponse, deriveFinalizeRow, finalizeMarkdown, finalizePollInterval, FINALIZE_STATES } from '../desktop/plugin.js'

const item = (number = 1) => ({ repo: 'acme/app', number, title: `Issue ${number}` })
const issue = (number, { state = 'OPEN', prs = [] } = {}) => ({ data: { i0: { issue: {
  number, title: `Issue ${number}`, state, stateReason: state === 'CLOSED' ? 'NOT_PLANNED' : null,
  url: `https://github.com/acme/app/issues/${number}`, repository: { nameWithOwner: 'acme/app' },
  timelineItems: { nodes: prs.map(pr => ({ subject: pr })) },
} } } })
const pr = (number, state = 'OPEN', check = 'SUCCESS', mergedAt = null) => ({
  number, url: `https://github.com/acme/app/pull/${number}`, title: `PR ${number}`, state,
  merged: state === 'MERGED', mergedAt,
  closingIssuesReferences: { nodes: [{ number: 1, repository: { nameWithOwner: 'acme/app' } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: check } } }] },
})

test('finalization derives all six states, handles NOT_PLANNED closure and selects latest open PR', () => {
  assert.equal(deriveFinalizeRow(item(), { ...issue(1).data.i0.issue }, false).state, FINALIZE_STATES.open)
  assert.equal(deriveFinalizeRow(item(), { ...issue(1).data.i0.issue }, true).state, FINALIZE_STATES.working)
  assert.equal(deriveFinalizeRow(item(), issue(1, { prs: [pr(2)] }).data.i0.issue).state, FINALIZE_STATES.pr)
  assert.equal(deriveFinalizeRow(item(), issue(1, { prs: [pr(2, 'OPEN', 'FAILURE')] }).data.i0.issue).state, FINALIZE_STATES.failing)
  assert.equal(deriveFinalizeRow(item(), issue(1, { prs: [pr(2, 'MERGED', 'SUCCESS', '2026-01-01')] }).data.i0.issue).state, FINALIZE_STATES.merged)
  const closed = issue(1, { state: 'CLOSED' }).data.i0.issue
  closed.stateReason = 'NOT_PLANNED'
  assert.equal(deriveFinalizeRow(item(), closed).state, FINALIZE_STATES.closed)
  assert.equal(deriveFinalizeRow(item(), issue(1, { state: 'CLOSED', prs: [pr(7)] }).data.i0.issue).state, FINALIZE_STATES.closed)
  assert.equal(deriveFinalizeRow(item(), issue(1, { prs: [pr(7, 'CLOSED')] }).data.i0.issue).state, FINALIZE_STATES.open)
  assert.equal(deriveFinalizeRow(item(), issue(1, { state: 'CLOSED', prs: [pr(7, 'CLOSED')] }).data.i0.issue).state, FINALIZE_STATES.closed)
  const selected = deriveFinalizeRow(item(), issue(1, { prs: [pr(3, 'MERGED', 'SUCCESS', '2026-01-01'), pr(4, 'OPEN')] }).data.i0.issue)
  assert.equal(selected.pr.number, 4)
})

test('closing references and willCloseTarget attribute cross-repository PRs', () => {
  const cross = { ...pr(8), closingIssuesReferences: { nodes: [{ number: 1, repository: { nameWithOwner: 'acme/app' } }] } }
  const result = decodeFinalizeResponse(issue(1, { prs: [cross] }), [item()])
  assert.equal(result[0].pr.url, cross.url)
  const linked = { ...issue(1).data.i0.issue, timelineItems: { nodes: [{ willCloseTarget: true, source: { ...pr(9), closingIssuesReferences: { nodes: [] } } }] } }
  assert.equal(deriveFinalizeRow(item(), linked).pr.number, 9)
})

test('GraphQL request batches max 50 and markdown is GFM with escaped cells', () => {
  const request = buildFinalizeQuery([item()])
  assert.match(request.query, /closingIssuesReferences/)
  assert.throws(() => buildFinalizeQuery(Array.from({ length: 51 }, (_, i) => item(i + 1))), /50/)
  assert.equal(finalizeMarkdown([{ ...item(), title: 'pipe | line\nbreak', state: 'offen', url: 'https://github.com/acme/app/issues/1' }]),
    '| Issue | Zustand | PR |\n| --- | --- | --- |\n| [acme/app#1](https://github.com/acme/app/issues/1) pipe \\| line break | offen | – |')
})

test('polling stops only when every issue is in a stable finalization state', () => {
  assert.equal(finalizePollInterval([{ state: FINALIZE_STATES.merged }]), false)
  assert.equal(finalizePollInterval([{ state: FINALIZE_STATES.pr }]), false)
  assert.equal(finalizePollInterval([{ state: FINALIZE_STATES.open }]), 30_000)
  assert.equal(finalizePollInterval([{ state: FINALIZE_STATES.merged }, { state: FINALIZE_STATES.failing }]), 30_000)
})
