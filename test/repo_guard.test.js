import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('desktop plugin contains no foreign repository identifiers', () => {
  const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
  const formerOwners = [['claudi', 'umio'].join(''), ['claudioor', 'junior'].join('')].join('|')
  assert.doesNotMatch(source, new RegExp(`${formerOwners}|Crome696/`, 'i'))
})
