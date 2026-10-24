/**
 * Measure one toggle in the running app: box counts before and after.
 *
 * Usage: node scripts/probe-app-toggle.mjs [port] [label]
 */
const port = Number(process.argv[2] ?? 9222)
const label = process.argv[3] ?? '隐藏回答'
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
const evaluate = async expression => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) return { error: reply.result.exceptionDetails.exception?.description ?? reply.result.exceptionDetails.text }
  return reply.result?.result?.value
}
await send('Runtime.enable')

const count = `(() => {
  const editor = document.querySelector('.twt-editor')
  if (editor === null) return { error: 'editor closed' }
  const svg = editor.querySelector('svg')
  return {
    boxes: svg === null ? 0 : svg.querySelectorAll('rect').length,
    groups: svg === null ? 0 : svg.querySelectorAll('g').length,
    rows: editor.querySelectorAll('.twt-erow').length,
    checked: (() => {
      const box = [...editor.querySelectorAll('label')].find(l => (l.textContent || '').includes('${label}'))?.querySelector('input')
      return box === undefined ? 'missing' : box.checked
    })(),
  }
})()`

const before = await evaluate(count)
console.log('before:', JSON.stringify(before))

const clicked = await evaluate(`(() => {
  const box = [...document.querySelectorAll('.twt-editor label')].find(l => (l.textContent || '').includes('${label}'))?.querySelector('input')
  if (box === undefined) return 'no such toggle'
  box.click()
  return 'clicked → ' + box.checked
})()`)
console.log('click:', clicked)
await new Promise(resolve => setTimeout(resolve, 2500))

const after = await evaluate(count)
console.log('after:', JSON.stringify(after))

const back = await evaluate(`(() => {
  const box = [...document.querySelectorAll('.twt-editor label')].find(l => (l.textContent || '').includes('${label}'))?.querySelector('input')
  if (box === undefined) return 'no such toggle'
  box.click()
  return 'restored → ' + box.checked
})()`)
console.log('restore:', back)
socket.close()
