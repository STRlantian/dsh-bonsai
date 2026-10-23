#!/usr/bin/env node
/**
 * Does folding whole turns actually reduce the prompt, and how does the model behave?
 *
 * Script: four turns. The first two carry exact facts. Then folding (scope `turns`, keep 1)
 * should remove turns 1–2 from the model view, leaving the placeholder. The last question asks
 * for a fact from turn 1 while tools are allowed, so the run records:
 *
 *   - prompt tokens per turn (does the fold pay off?)
 *   - whether the model calls `retrieve_context`, or guesses, or says it does not know
 *   - whether the answer is correct
 *
 * Usage: node scripts/probe-turn-fold.mjs --port 19821 --token <token> [--mode turns|tools|off]
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '19821'))
const token = argOf('token', '')
const mode = argOf('mode', 'turns')
const threshold = Number(argOf('threshold', '15'))
const outPath = argOf('out', `docs/experiments/turn-fold-${mode}.json`)
const base = `http://127.0.0.1:${port}`

const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
const cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')

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

const post = async (path, body) => (await fetch(`${base}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
})).json()

const settings = async () => (await fetch(`${base}/api/token-tree/settings`, { headers: { cookie } })).json()
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

async function say(sessionId, text, waitMs = 0) {
  const before = lastSeq(await pageOf(sessionId))
  await rpc('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
  })
  for (let waited = 0; waited < 300; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) {
      // Let the assistant message commit after the turn marker, and report a failed turn.
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs))
      return pageOf(sessionId)
    }
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

const billed = page => {
  const usage = recordsOf(page).filter(record => record.type === 'assistant/message' && record.data?.usage).map(record => record.data.usage)
  const last = usage[usage.length - 1]
  return last === undefined ? 0 : (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0)
}

await post('/api/token-tree/settings', {
  foldAboveTokens: mode === 'off' ? 0 : threshold,
  foldKeepTurns: 1,
  foldScope: mode === 'tools' ? 'tools' : 'turns',
})
console.log('settings:', JSON.stringify((await settings()).overrides))

const sessionId = (await rpc('session/create', { request: {} })).sessionId
const prompts = []
const turns = [
  '你好，只回复「收到」。',
  '记住这条：探针超时是 1733 毫秒，只回复「收到」。',
  '再记住一条：灰度批次编号是 rbx-2291，只回复「收到」。',
]
for (const text of turns) prompts.push(billed(await say(sessionId, text)))

// The fold lands at turn end, so the first ask still sees the fact; the second does not.
const question = '探针超时是多少毫秒？如果上下文里没有这条信息，可以用工具查；不要猜。只答数字或「不确定」。'
const firstAsk = await say(sessionId, question, 1500)
prompts.push(billed(firstAsk))
const answerPage = await say(sessionId, question, 1500)
const records = recordsOf(answerPage)
const failedTurn = records.filter(record => record.type === 'turn/end').map(record => record.data?.reason).filter(reason => reason?.kind === 'error')
if (failedTurn.length > 0) console.log('turn errors:', JSON.stringify(failedTurn).slice(0, 200))
const retrieveCalls = records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length
const otherTools = records.filter(record => record.type === 'tool/call' && record.data?.name !== 'retrieve_context').length
const answer = lastAnswer(answerPage)
prompts.push(billed(answerPage))

const firstRecords = recordsOf(firstAsk)
const firstRetrieve = firstRecords.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length
const firstAnswer = lastAnswer(firstAsk)
const state = await settings()
console.log(`first ask: ${JSON.stringify(firstAnswer.slice(0, 60))} · retrieve=${firstRetrieve}`)
console.log(`prompts: ${prompts.join(' → ')} (${mode})`)
console.log(`fold: ${JSON.stringify(state.fold)}`)
console.log(`answer: ${JSON.stringify(answer.slice(0, 90))} · retrieve=${retrieveCalls} · other tools=${otherTools}`)

await post('/api/token-tree/settings', { foldAboveTokens: null, foldKeepTurns: null, foldScope: null })
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({
  mode,
  sessionId,
  prompts,
  fold: state.fold,
  answer,
  correct: answer.includes('1733'),
  refused: answer.includes('不确定'),
  retrieveCalls,
  otherTools,
  failedTurn: failedTurn.length,
  firstAnswer,
  firstRetrieve,
}, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
