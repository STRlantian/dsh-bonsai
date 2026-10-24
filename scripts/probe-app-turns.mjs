/**
 * Read-only look at the transcript's turn markers, to see what a jump can land on.
 *
 * Usage: node scripts/probe-app-turns.mjs [port]
 *
 * Nothing is clicked and no big subtree is serialised: one query, one small result.
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
  if (frame.id !== undefined && pending.has(frame.id)) { pending.get(frame.id)(frame); pending.delete(frame.id) }
})
const send = (method, params = {}) => {
  const id = nextId++
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise(resolve => pending.set(id, resolve))
}
await send('Runtime.enable')
const reply = await send('Runtime.evaluate', {
  expression: `(() => {
    const rows = [...document.querySelectorAll('[data-chat-turn]')]
    const turns = rows.map(row => Number(row.getAttribute('data-chat-turn')))
    return {
      rows: rows.length,
      first: turns.slice(0, 6),
      last: turns.slice(-6),
      unique: new Set(turns).size,
      sample: rows.slice(0, 4).map(row => ({ turn: row.getAttribute('data-chat-turn'), text: (row.textContent || '').replace(/\\s+/g, ' ').slice(0, 40) })),
      hasNodeKeys: document.querySelectorAll('[data-chat-node-key]').length,
    }
  })()`,
  returnByValue: true,
})
console.log(JSON.stringify(reply.result?.result?.value ?? reply.result?.exceptionDetails, null, 1))
socket.close()
