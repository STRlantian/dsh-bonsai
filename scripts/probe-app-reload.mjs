/**
 * Reload the app's window over CDP so it picks up a freshly installed client bundle.
 *
 * The host keeps running, so the conversation is unaffected.
 *
 * Usage: node scripts/probe-app-reload.mjs [port]
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
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
console.log('reloaded', target.url.split('?')[0])
socket.close()
