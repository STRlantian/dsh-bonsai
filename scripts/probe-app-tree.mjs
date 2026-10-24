/**
 * Answer one question about the running app: what does the tree view actually receive?
 *
 * Usage: node scripts/probe-app-tree.mjs [port]
 */
const port = Number(process.argv[2] ?? 9222)
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
  if (frame.id !== undefined && pending.has(frame.id)) {
    pending.get(frame.id)(frame)
    pending.delete(frame.id)
  }
})
const send = (method, params = {}) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise(resolve => pending.set(id, resolve))
}
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) return { error: reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text }
  return reply.result?.result?.value
}
await send('Runtime.enable')

// Record the calls the tree view makes, and keep their status plus body size.
const recording = await evaluate(`(async () => {
  const original = window.fetch
  const seen = []
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input.url
    const promise = original.apply(this, arguments)
    if (url.includes('/api/token-tree/')) {
      promise.then(async response => {
        const clone = response.clone()
        const text = await clone.text().catch(() => '')
        seen.push({ url, status: response.status, bytes: text.length, head: text.slice(0, 120) })
      }).catch(error => seen.push({ url, error: String(error) }))
    }
    return promise
  }
  await new Promise(r => setTimeout(r, 3200))
  window.fetch = original
  return seen
})()`)
console.log('calls:', JSON.stringify(recording, null, 1).slice(0, 1600))

const view = await evaluate(`(() => {
  const editor = document.querySelector('.twt-editor')
  if (editor === null) return 'editor closed'
  const active = [...editor.querySelectorAll('button')].filter(b => b.getAttribute('data-kind') === 'primary').map(b => (b.textContent || '').trim())
  const boxes = editor.querySelectorAll('.twt-gbox, svg g').length
  const rows = editor.querySelectorAll('.twt-erow').length
  const empty = (editor.querySelector('.twt-note, .twt-empty')?.textContent || '').trim()
  return {
    active,
    rows,
    svgGroups: boxes,
    empty,
    text: (editor.textContent || '').replace(/\\s+/g, ' ').slice(0, 260),
  }
})()`)
console.log('view:', JSON.stringify(view, null, 1))
socket.close()
