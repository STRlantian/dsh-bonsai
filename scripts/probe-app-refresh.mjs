/**
 * Does the open graph follow the conversation? Sample the payload and the boxes over time.
 *
 * Usage: node scripts/probe-app-refresh.mjs [port] [seconds]
 */
const port = Number(process.argv[2] ?? 9222)
const seconds = Number(process.argv[3] ?? 8)
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const target = list.find(item => item.type === 'page' && item.url.startsWith('dsh-app://')) ?? list.find(item => item.type === 'page')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let nextId = 1
const pending = new Map()
socket.addEventListener('message', event => {
  const frame = JSON.parse(event.data)
  if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id) }
})
const send = (method, params = {}) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise(resolve => pending.set(id, resolve))
}
const evaluate = async (expression, timeout = 120000) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) return { error: reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text }
  return reply.result?.result?.value
}
await send('Runtime.enable')

// The page's own last payload, then the graph's rendered box count.
const sample = `(async () => {
  const editor = document.querySelector('.twt-editor')
  const svg = editor?.querySelector('svg')
  const url = new URL(window.location.href)
  // Ask the host the same way the editor does, so this reflects the conversation, not the cache.
  const session = (document.querySelector('.twt-actions-row') ? '' : '')
  return {
    boxes: svg === null || svg === undefined ? 0 : svg.querySelectorAll('rect').length,
    titles: [...(svg?.querySelectorAll('text') ?? [])].slice(0, 3).map(node => (node.textContent || '').slice(0, 24)),
  }
})()`

const first = await evaluate(sample)
console.log('t0 boxes:', first.boxes, '·', JSON.stringify(first.titles))

// Count the tree responses the editor receives over the window and their node totals.
const polled = await evaluate(`(async () => {
  const original = window.fetch
  const seen = []
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url
    const promise = original.apply(this, arguments)
    if (url.includes('/api/token-tree/tree')) {
      promise.then(async response => {
        const clone = response.clone()
        try {
          const body = await clone.json()
          seen.push({ nodes: body.stats?.nodes ?? -1, focus: body.focusId ?? '' })
        } catch (error) { seen.push({ error: String(error) }) }
      }).catch(error => seen.push({ error: String(error) }))
    }
    return promise
  }
  await new Promise(r => setTimeout(r, ${seconds * 1000}))
  window.fetch = original
  return seen
})()`)
console.log('payloads seen:', JSON.stringify(polled))

const second = await evaluate(sample)
console.log('t1 boxes:', second.boxes, '·', JSON.stringify(second.titles))
socket.close()
