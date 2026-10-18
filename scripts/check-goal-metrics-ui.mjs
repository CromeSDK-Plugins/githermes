// Optional real-browser component/transport check; no live model/GitHub calls.
// Install playwright/react/react-dom/esbuild in an isolated runner directory and
// set GITHERMES_UI_RUNNER to that directory. Outputs go to Hermes scratch only.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runner = process.env.GITHERMES_UI_RUNNER
if (!runner || !process.env.TMPDIR) throw new Error('Set GITHERMES_UI_RUNNER and TMPDIR (Hermes scratch).')
const require = createRequire(join(runner, 'package.json'))
const { build } = require('esbuild'), { chromium } = require('playwright')
const work = join(process.env.TMPDIR, 'githermes12-ui-evidence')
mkdirSync(work, { recursive: true })
const shim = join(work, 'sdk.mjs')
writeFileSync(shim, `export * from ${JSON.stringify(join(root, 'node_modules/@hermes/plugin-sdk/index.js'))};
import React, { useSyncExternalStore } from ${JSON.stringify(require.resolve('react'))};
export const atom = initial => { let value = initial; const listeners = new Set(); return { get: () => value, set: next => { value = next; listeners.forEach(fn => fn()) }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) } } };
export const useValue = store => useSyncExternalStore(store.subscribe, store.get);
export const Button = ({children, size, variant, ...props}) => React.createElement('button', props, children);
`)
const entry = join(work, 'entry.mjs')
writeFileSync(entry, `import React from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { $goalMetrics, GoalMetricsOverview, GoalMetricsSettings, setMetricsController } from ${JSON.stringify(join(root, 'desktop/plugin.js'))};
import { createMetricsController } from ${JSON.stringify(join(root, 'desktop/plugin.js'))};
const storage = { get: (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') ?? fallback, set: (key, value) => localStorage.setItem(key, JSON.stringify(value)) };
let done = false;
const api = { state: { profile: { get: () => 'default' }, connectionId: { get: () => 'local' } }, requestProfile: async (route, method, params) => {
  if(method === 'session.active_list') return { sessions: [{session_key:'one',id:'rt-one'}, {session_key:'two',id:'rt-two'}] };
  if(method === 'session.control.read') return {control:{goal:{status:done?'done':'active',created_at:1792022400}}};
  if(method === 'session.usage') return params.session_id==='rt-one' ? {input:1000000, output:250000, reasoning:1000} : {input:0,output:0,reasoning:0};
  throw Error(method);
} };
const controller = createMetricsController(api, storage, { onChange: next => $goalMetrics.set(next), interval:60000 });
setMetricsController(controller);
if (!controller.records.length) for (const [id, profile] of [['one','worker'],['two','zero']]) controller.track({stored_session_id:id,session_id:'rt-'+id,stage:'complete',plan:{profile,items:[{repo:'example/repo',number:id==='one'?12:13}],prompt:'PRIVATE PROMPT'},modelReadback:{model:'test-model',provider:'test',reasoning_effort:'high',fast:false}},'issue');
await controller.refresh();
window.fixtureDone = async () => { done=true; await controller.refresh() };
window.updatePricesExternally = value => controller.setPrices(value);
createRoot(document.getElementById('app')).render(React.createElement(React.Fragment, {}, React.createElement(GoalMetricsOverview, {}), React.createElement(GoalMetricsSettings, {})));
`)
const bundle = join(work, 'bundle.js')
await build({ entryPoints: [entry], bundle: true, outfile: bundle, format: 'esm', platform: 'browser', alias: { '@hermes/plugin-sdk': shim, react: require.resolve('react'), 'react/jsx-runtime': require.resolve('react/jsx-runtime') } })
const html = '<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/bundle.js"></script>'
const { readFileSync } = await import('node:fs')
const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/bundle.js' ? 'text/javascript' : 'text/html'); res.end(req.url === '/bundle.js' ? readFileSync(bundle) : html) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
let browser, chosen
const browsers = [
  ['Edge', { channel: 'msedge' }], ['Chrome', { channel: 'chrome' }], ['Runner Chromium', {}],
]
try {
  for (const [name, options] of browsers) {
    try { browser = await chromium.launch({ headless: true, ...options }); chosen = name; break }
    catch (e) { console.log(`${name} unavailable: ${e.message.split('\n')[0]}`) }
  }
  assert.ok(browser, 'No permitted Chromium browser could launch')
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('heading', { name: 'Goal-Verbrauch · lokal gespeichert' }).waitFor()
  await page.getByLabel('Profilfilter').selectOption('zero')
  assert.match(await page.locator('article').innerText(), /Input: nicht verfügbar/)
  assert.match(await page.locator('article').innerText(), /Kosten: nicht verfügbar/)
  await page.getByLabel('Profilfilter').selectOption('worker')
  assert.match(await page.locator('article').innerText(), /kein Preis hinterlegt/)
  const table = {version:1,rows:[{model:'test-model',provider:'test',date:'2026-10-15',input:2,output:8,cacheRead:0.5,cacheWrite:3}]}
  await page.getByLabel('Preistabelle JSON').fill(JSON.stringify(table))
  await page.getByRole('button', {name:'Preistabelle speichern'}).click()
  await page.getByText('Preistabelle gespeichert.', {exact:true}).waitFor()
  assert.match(await page.locator('article').innerText(), /4\.000000 USD/)
  assert.match(await page.locator('article').innerText(), /geschätzt.*2026-10-15.*Teilsumme/)
  const externalTable = {...table, rows: table.rows.map(row => ({...row, date:'2026-10-16'}))}
  await page.evaluate(value => window.updatePricesExternally(value), externalTable)
  await page.waitForFunction(() => document.querySelector('[aria-label="Preistabelle JSON"]').value.includes('2026-10-16'))
  for (const value of ['week','month','day']) { await page.getByLabel('Zeitraum', {exact:true}).selectOption(value); assert.equal(await page.locator('[data-metric-period]').count(),1) }
  await page.evaluate(() => window.fixtureDone())
  await page.getByText(/Ende \(beobachtet\):/).waitFor()
  const [download] = await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'CSV exportieren'}).click()])
  const path = join(work, 'goals.csv'); await download.saveAs(path)
  const csv = readFileSync(path,'utf8'); assert.match(csv,/worker/); assert.ok(!csv.includes('"zero"')); assert.ok(!csv.includes('PRIVATE'))
  const stored = await page.evaluate(() => localStorage.getItem('goalUsageMetricsV1'))
  assert.ok(!stored.includes('PRIVATE')); assert.ok(!stored.includes('prompt'))
  await page.reload(); await page.getByRole('heading', {name:'Goal-Verbrauch · lokal gespeichert'}).waitFor()
  await page.getByLabel('Profilfilter').selectOption('worker')
  assert.match(await page.locator('article').innerText(), /Ende \(beobachtet\):/)
  assert.match(await page.locator('article').innerText(), /4\.000000 USD/)
  await page.getByLabel('Modellfilter').selectOption('test-model')
  await page.setViewportSize({width:360,height:800})
  assert.equal(await page.locator('article').count(),1)
  assert.deepEqual(errors,[])
  const report = {browser:chosen, assertions:'filters, unknown-zero usage, dated price save, external price-table draft resync, partial estimate, day/week/month, observed done, CSV download, privacy, reload persistence, narrow viewport', csv:path, pageErrors:errors}
  writeFileSync(join(work,'report.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2))
  await context.close()
} finally { await browser?.close(); server.close() }
