/**
 * Drive the real client bundle against a live host.
 *
 * The unit tests use a hand-written payload; this script uses whatever the host actually serves,
 * which is the only way to catch a mismatch between the two (shape, kinds, empty sessions).
 *
 * Usage: node scripts/probe-client-live.mjs <origin> <cookie>
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as ReactDOMClient from 'react-dom/client'

const origin = process.argv[2]
const cookie = process.argv[3] ?? ''
if (origin === undefined) throw new Error('usage: probe-client-live.mjs <origin> <cookie>')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: origin + '/' })
const { window } = dom
globalThis.window = window
globalThis.document = window.document
globalThis.navigator = window.navigator
globalThis.HTMLElement = window.HTMLElement
globalThis.MouseEvent = window.MouseEvent
globalThis.Event = window.Event
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
globalThis.cancelAnimationFrame = id => clearTimeout(id)
globalThis.getComputedStyle = window.getComputedStyle.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const requests = []
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, origin)
  requests.push({ method: init.method ?? 'GET', url: url.href, body: init.body })
  const response = await fetch(url.href, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, 'content-type': 'application/json' },
  })
  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    headers: { get: name => response.headers.get(name) },
    text: async () => text,
    json: async () => JSON.parse(text),
  }
}

let factory
const components = {}
window.__ModuleLoader__ = { load: spec => { factory = spec.factory } }

const bundle = readFileSync(join(process.cwd(), 'client', 'client.js'), 'utf8')
new Function('window', 'document', bundle)(window, window.document)
if (factory === undefined) throw new Error('bundle did not register')

const platformRequire = name => name === 'react'
  ? React
  : name === 'react-dom/client'
    ? ReactDOMClient
    : ReactDOM
const exported = factory(platformRequire)
await React.act(async () => {
  exported.apply({
    slots: {
      inject: (_name, body) => body(),
      register: (spec, component) => { components[spec.name] = component; return () => {} },
    },
    on: () => () => {},
    effect: body => body(),
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    get: () => undefined,
  })
})

const container = window.document.getElementById('root')
const root = ReactDOMClient.createRoot(container)
const flush = async () => { for (let i = 0; i < 10; i++) await React.act(async () => { await Promise.resolve() }) }
const click = async label => {
  const target = [...window.document.querySelectorAll('button, label')]
    .find(node => (node.textContent ?? '').trim().includes(label))
  if (target === undefined) throw new Error(`no control "${label}"`)
  await React.act(async () => { target.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await flush()
}

await React.act(async () => {
  root.render(React.createElement(components['conversation.session.header.actions'], { sessionId: process.argv[4] ?? '' }))
})
await flush()

await click('盆栽')
const tabs = [...window.document.querySelectorAll('.twt-tab')].map(node => node.textContent?.trim())
console.log('tabs:', tabs.join(' | '))
const modes = [...window.document.querySelectorAll('button')].map(node => node.textContent?.trim()).filter(Boolean)
console.log('controls:', modes.slice(0, 18).join(' | '))

await click('完整树')
const rowsOf = () => [...window.document.querySelectorAll('.twt-erow')]
  .map(row => ({ kind: row.querySelector('.twt-ekind')?.getAttribute('data-kind'), text: (row.querySelector('.twt-q')?.textContent ?? '').slice(0, 18) }))
const before = rowsOf()
console.log('rows before:', before.length, JSON.stringify(before.slice(0, 6)))

const answerToggle = [...window.document.querySelectorAll('label')].find(label => (label.textContent ?? '').includes('隐藏回答'))
console.log('answer toggle found:', answerToggle !== undefined)
if (answerToggle !== undefined) {
  await React.act(async () => { answerToggle.querySelector('input').click() })
  await flush()
  const after = rowsOf()
  console.log('rows after:', after.length, JSON.stringify(after.slice(0, 6)))
  console.log('answers removed:', before.filter(row => row.kind === 'answer').length !== 0 && after.every(row => row.kind !== 'answer'))
  await React.act(async () => { answerToggle.querySelector('input').click() })
  await flush()
}

// Ask the host again the way the poll does, and see whether the payload moved on.
const before2 = requests.filter(entry => entry.url.includes('/api/token-tree/tree')).length
await new Promise(resolve => setTimeout(resolve, 2300))
await flush()
const after2 = requests.filter(entry => entry.url.includes('/api/token-tree/tree')).length
console.log('tree fetches: before', before2, '→ after 2.3s', after2, '· polling', after2 > before2)

await React.act(async () => { exported.__disposeEditorHost?.() })
await React.act(async () => { root.unmount() })
window.close()
