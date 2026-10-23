#!/usr/bin/env node
/**
 * Is the index even needed? After compaction, ask the facts with tools disabled.
 *
 * If the answers still come back exact, the summary kept them and no pointer can improve
 * anything (the ceiling effect). If they fail, retrieval is the only way back and the index
 * becomes worth testing properly.
 *
 * Usage: node scripts/probe-compaction-ceiling.mjs --port 19751 --token <token>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '19751'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/compaction-ceiling.json')
const base = `http://127.0.0.1:${port}`

let cookie = ''
const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')

async function rpc(method, requestArgs) {
  const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
  const res = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await res.json()
  if (payload.result?.ok !== true) throw new Error(`${method}: ${payload.result?.error?.message ?? 'failed'}`)
  return payload.result.value
}

const recordsOf = page => (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type)
const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)
const pageOf = async sessionId => {
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
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
  })
  for (let waited = 0; waited < 400; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
  }
  throw new Error('turn did not finish')
}

const lastAnswer = page => {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  return (last?.data?.message?.content ?? last?.data?.content ?? [])
    .filter(block => block?.type === 'text')
    .map(block => block.text)
    .join(' ')
    .trim()
}

const facts = [
  { seed: '部署记录，原样保存：probe_timeout_ms 是 1733，max_retries 是 4。', ask: '探针超时是多少毫秒？', expect: '1733' },
  { seed: '构建校验：artifact 标识是 9f2c41ab77de05。', ask: 'artifact 标识前 12 位是什么？', expect: '9f2c41ab77de' },
  { seed: '灰度批次编号是 rbx-2291，比例 7%。', ask: '灰度批次编号是什么？', expect: 'rbx-2291' },
  { seed: '回滚阈值：错误率超过 0.42% 即回滚。', ask: '回滚的错误率阈值是多少？', expect: '0.42' },
]

const sessionId = (await rpc('session/create', { request: {} })).sessionId
for (const fact of facts) await say(sessionId, `记录一条工程信息，不要评论、不要调用工具：${fact.seed}`)
for (let index = 0; index < 6; index++) await say(sessionId, `例行检查 ${index + 1} 已完成，只回复「收到」。`)

const page = await pageOf(sessionId)
const agentId = recordsOf(page).find(record => record.type === 'turn/end')?.data?.agentId ?? sessionId
const compacted = await rpc('commands/execute', { agentId, line: '/compact', submittedAttachments: [] })
console.log('compaction:', JSON.stringify(compacted?.output ?? compacted).slice(0, 120))

const asked = []
for (const fact of facts) {
  const reply = await say(sessionId, `禁止使用任何工具，只凭对话内容回答；如果记不清就回答「不确定」，不要猜测。${fact.ask}`)
  const answer = lastAnswer(reply)
  const tools = recordsOf(reply).filter(record => record.type === 'tool/call').length
  asked.push({ expect: fact.expect, answer: answer.slice(0, 120), hit: answer.includes(fact.expect), tools })
  console.log(`${answer.includes(fact.expect) ? 'HIT ' : 'MISS'} expect=${fact.expect} tools=${tools} answer=${JSON.stringify(answer.slice(0, 80))}`)
}

mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ sessionId, correct: asked.filter(item => item.hit).length, asked, details: asked }, undefined, 2)}\n`, 'utf8')
console.log(`\ncorrect: ${asked.filter(item => item.hit).length}/${asked.length} · evidence: ${outPath}`)
