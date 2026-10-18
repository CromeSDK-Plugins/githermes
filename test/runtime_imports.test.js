import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// Hermes Desktop loads desktop/plugin.js uncompiled and only resolves these specifiers (#39).
const ALLOWED = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')

function staticSpecifiers(code) {
  const found = []
  for (const m of code.matchAll(/^\s*(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm)) found.push(m[1])
  for (const m of code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) found.push(m[1])
  return found
}

function dynamicImports(code) {
  return [...code.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)].map(m => m[1].trim())
}

test('desktop/plugin.js statically imports only @hermes/plugin-sdk, react and react/jsx-runtime', () => {
  const specifiers = staticSpecifiers(source)
  assert.ok(specifiers.includes('@hermes/plugin-sdk'), 'SDK import not detected; the import scan is broken')
  const unsupported = specifiers.filter(s => !ALLOWED.has(s))
  assert.deepEqual(unsupported, [], `unsupported imports: ${unsupported.join(', ')}`)
})

test('desktop/plugin.js has no dynamic import() outside the allowlist', () => {
  const unsupported = dynamicImports(source).filter(arg => {
    const literal = arg.match(/^['"]([^'"]+)['"]$/)
    return !literal || !ALLOWED.has(literal[1])
  })
  assert.deepEqual(unsupported, [], `unsupported dynamic imports: ${unsupported.join(', ')}`)
})

test('desktop/ ships the runtime as a single file', () => {
  const scripts = readdirSync(new URL('../desktop/', import.meta.url)).filter(name => /\.[cm]?js$/.test(name))
  assert.deepEqual(scripts, ['plugin.js'])
})
