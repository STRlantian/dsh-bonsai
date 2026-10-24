/**
 * Drive the running desktop app over the Chrome DevTools Protocol.
 *
 * Usage: node scripts/probe-app-cdp.mjs [port]
 *
 * Prints what the live page actually has: whether the tree button and the hide switches are there,
 * whether clicking them changes the rows, and whether the tree polls while the editor is open.
 */
const port = Number(process.argv[2] ?? 9222)

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const targets = list.filter(target => target.type === 'page')
if (targets.length === 0) {
  console.log('no page target; targets:', list.map(t => `${t.type}:${t.url}`).join(', '))
  process.exit(1)
}
const target = targets.find(t => t.url.includes('127.0.0.1') && !t.url.includes('devtools')) ?? targets[0]
console.log('attached:', target.url.replace(/\?token=[^&]+/, '?token=***'), '| title:', target.title)

const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let nextId = 1
const pending = new Map()
socket.addEventListener('message', event => {
  const frame = JSON.parse(event.data)
  if (frame.id !== undefined && pending.has(frame.id)) {
    pending.get(frame.id)(frame)
    pending.delete(frame.id)
  }
})

function send(method, params = {}) {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise(resolve => pending.set(id, resolve))
}

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) {
    return { error: reply.result.exceptionDetails.text + ': ' + (reply.result.exceptionDetails.exception?.description ?? '') }
  }
  return reply.result?.result?.value
}

await send('Runtime.enable')

const report = {}
report.buttons = await evaluate(`[...document.querySelectorAll('button')].map(b => (b.textContent||'').trim()).filter(Boolean).slice(0, 20)`)
report.hasDock = await evaluate(`document.querySelector('.twt-dock') !== null`)
report.hasEditor = await evaluate(`document.querySelector('.twt-editor') !== null`)

// Open the editor if it is closed, then list the tabs and the modes.
report.opened = await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('盆栽'))
  if (button === undefined) return 'no 盆栽 button'
  if (document.querySelector('.twt-editor') === null) button.click()
  return 'clicked'
})()`)
await new Promise(resolve => setTimeout(resolve, 1500))
report.hasEditorAfterClick = await evaluate(`document.querySelector('.twt-editor') !== null`)
report.tabs = await evaluate(`[...document.querySelectorAll('.twt-tab')].map(t => (t.textContent || '').trim())`)
report.controls = await evaluate(`[...document.querySelectorAll('.twt-editor button, .twt-editor label')].map(t => (t.textContent || '').trim()).filter(Boolean).slice(0, 30)`)

// Switch to the node list, count rows by kind, toggle answers off and count again.
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.twt-tab')].find(t => (t.textContent || '').includes('完整树'))
  if (tab !== undefined) tab.click()
  return tab !== undefined
})()`)
await new Promise(resolve => setTimeout(resolve, 1200))

const rowKinds = `(() => {
  const rows = [...document.querySelectorAll('.twt-erow')]
  const kinds = {}
  for (const row of rows) {
    const kind = row.querySelector('.twt-ekind')?.getAttribute('data-kind') ?? '?'
    kinds[kind] = (kinds[kind] ?? 1) + 0
    kinds[kind] = (kinds[kind] ?? 0) + 1
  }
  return { total: rows.length, kinds }
})()`
report.rowsBefore = await evaluate(rowKinds)

report.toggled = await evaluate(`(() => {
  const label = [...document.querySelectorAll('label')].find(l => (l.textContent || '').includes('隐藏回答'))
  if (label === undefined) return 'no 隐藏回答 label'
  const box = label.querySelector('input')
  if (box === undefined) return 'no checkbox'
  box.click()
  return 'clicked, checked=' + box.checked
})()`)
await new Promise(resolve => setTimeout(resolve, 1200))
report.rowsAfter = await evaluate(rowKinds)
report.toggleState = await evaluate(`(() => {
  const label = [...document.querySelectorAll('label')].find(l => (l.textContent || '').includes('隐藏回答'))
  return label === undefined ? 'missing' : label.querySelector('input')?.checked
})()`)

// Count tree fetches by patching fetch, then waiting for two poll intervals.
report.polling = await evaluate(`(async () => {
  const original = window.fetch
  let count = 0
  window.fetch = function (...args) { count++; return original.apply(this, args) }
  await new Promise(r => setTimeout(r, 4600))
  window.fetch = original
  return count
})()`)

for (const [key, value] of Object.entries(report)) {
  console.log(`${key}:`, typeof value === 'object' ? JSON.stringify(value) : value)
}

socket.close()
