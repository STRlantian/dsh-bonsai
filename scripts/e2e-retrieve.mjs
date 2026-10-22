#!/usr/bin/env node
/**
 * End-to-end check that the tool path really uses the new retrieval behaviour.
 *
 * The offline benches prove the algorithm; this proves the wiring: a session with long,
 * padded facts, then a prompt that forces `retrieve_context`, then read the tool result
 * back from the session log and look for the topic line being what matched.
 *
 * Usage:
 *   node scripts/e2e-retrieve.mjs --port 19552 --token <token>
 */
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const base = `http://127.0.0.1:${Number(argOf('port', '19552'))}`
const token = argOf('token', '')
let cookie = ''

const signIn = async () => {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
  if (cookie === '') throw new Error('token URL set no cookie')
}

async function rpc(method, requestArgs) {
  const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await response.json()
  if (payload.result?.ok !== true) throw new Error(`${method}: ${payload.result?.error?.message ?? 'failed'}`)
  return payload.result.value
}

const recordsOf = page => (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type)
const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)

async function pageOf(sessionId) {
  const address = { kind: 'session', sessionId }
  try {
    return await rpc('session/page', { request: { address, throughSeq: Number.MAX_SAFE_INTEGER } })
  } catch (error) {
    const match = /past cursor (\d+)/.exec(String(error.message))
    if (match === null) throw error
    return rpc('session/page', { request: { address, throughSeq: Number(match[1]) } })
  }
}

async function say(sessionId, text) {
  const before = lastSeq(await pageOf(sessionId))
  await rpc('session/prompt', {
    request: {
      requestId: crypto.randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: 'Asia/Shanghai',
    },
  })
  for (let waited = 0; waited < 300; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish')
}

const padding = '与本次问题无关的工程细节、日志格式、部署顺序、值班安排、发布窗口、监控阈值、回滚流程、容量规划、成本核算、依赖升级与文档同步等。'.repeat(10)

await signIn()
const sessionId = (await rpc('session/create', { request: {} })).sessionId
console.log(`session ${sessionId}`)

for (const fact of ['备份窗口固定在 03:15', '认证时钟容差 45 秒', '连接池上限 24']) {
  await say(sessionId, `项目背景记录（无需操作、不要调用工具或反问）：${fact}。${padding}`)
}

const page = await say(sessionId, '先调用 retrieve_context 检索「备份窗口 是多少」，然后把检索结果里出现的节点编号照抄一行，不要自己编。')
const records = recordsOf(page)
const calls = records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context')
const outputs = records.filter(record => record.type === 'tool/result').slice(-3)
console.log(`retrieve_context calls: ${calls.length}`)
for (const output of outputs) {
  const text = JSON.stringify(output.data ?? {}).slice(0, 400)
  console.log('  ', text)
}
const lastAnswer = records.filter(record => record.type === 'assistant/message').pop()
const content = (lastAnswer?.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join(' ')
console.log(`answer: ${content.slice(0, 200)}`)
