#!/usr/bin/env node
/**
 * A deliberately auditable A/B: same questions, alternating arms, script scoring.
 *
 * The earlier rounds mixed arithmetic across files and one table copied a number into
 * the wrong row, so this one is built to be checked by someone else:
 *
 * - arms alternate (A,B,B,A,A,B) rather than running all of one and then the other, so
 *   time drift and warm-cache effects hit both sides;
 * - every answer is scored by exact substring match against the planted value, printed
 *   question by question;
 * - token figures come from each `assistant/message.data.usage`, summed per run — the
 *   same fields the host logs, not a separate estimate;
 * - the run writes JSON with the session ids so any claim can be re-read from
 *   `~/.dsh/sessions/<...>/session.v4.jsonl.zstd` with `scripts/bench-cache.mjs`.
 *
 * Usage:
 *   node scripts/ab-rigorous.mjs --plan ABBAAB \
 *     --base-port 19541 --base-token <t> --plug-port 19542 --plug-token <t>
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const plan = argOf('plan', 'ABBAAB')
const factCount = Number(argOf('facts', '10'))
const askCount = Number(argOf('ask', '5'))
const outPath = argOf('out', 'docs/experiments/round-2026-10-22.json')

const arms = {
  A: { label: 'base', port: Number(argOf('base-port', '19541')), token: argOf('base-token', '') },
  B: { label: 'hint', port: Number(argOf('plug-port', '19542')), token: argOf('plug-token', '') },
}

/** One HTTP client bound to one host. */
function clientFor(arm) {
  const base = `http://127.0.0.1:${arm.port}`
  let cookie = ''
  return {
    async signIn() {
      const response = await fetch(`${base}/?token=${encodeURIComponent(arm.token)}`, { redirect: 'manual' })
      cookie = (response.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
      if (cookie === '') throw new Error(`arm ${arm.label}: the token URL set no cookie`)
    },
    async rpc(method, requestArgs) {
      const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
      const response = await fetch(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(envelope),
      })
      const payload = await response.json()
      if (payload.result?.ok !== true) throw new Error(`${arm.label} ${method}: ${payload.result?.error?.message ?? 'unknown'}`)
      return payload.result.value
    },
  }
}

/** Records as `{type, seq, data}` whatever envelope the page uses. */
const recordsOf = page => (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type !== undefined)
const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)

/** One page for a session, retrying once past the cursor error. */
async function pageOf(client, sessionId) {
  const address = { kind: 'session', sessionId }
  try {
    return await client.rpc('session/page', { request: { address, throughSeq: Number.MAX_SAFE_INTEGER } })
  } catch (error) {
    const match = /past cursor (\d+)/.exec(error instanceof Error ? error.message : String(error))
    if (match === null) throw error
    return client.rpc('session/page', { request: { address, throughSeq: Number(match[1]) } })
  }
}

/** Send one message and wait for its turn to end. */
async function say(client, sessionId, text) {
  const before = lastSeq(await pageOf(client, sessionId))
  await client.rpc('session/prompt', {
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
    const page = await pageOf(client, sessionId)
    const records = recordsOf(page)
    if (records.some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) return page
    if (records.some(record => (record.seq ?? 0) > before && record.type === 'tool/call' && record.data?.name === 'ask_user_question')) {
      throw new Error(`the agent asked a clarifying question: ${text.slice(0, 40)}`)
    }
  }
  throw new Error(`turn did not finish: ${text.slice(0, 40)}`)
}

/** Concatenated text of the last assistant message. */
function lastAnswer(page) {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  if (last === undefined) return ''
  return (last.data?.message?.content ?? [])
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('\n')
    .trim()
}

/**
 * The scenario: `facts` planted values, `ask` of them queried later.
 * @returns {{seeds: string[], questions: {ask: string, expect: string}[], planted: string[]}} scenario.
 */
function scenario() {
  const templates = [
    {
      seed: index => `项目背景记录（无需操作，也不要调用工具或反问）：服务 ${index} 的部署目录是 /srv/svc-${index}。`,
      ask: index => `只答目录。服务 ${index} 的部署目录是什么？`,
      expect: index => `/srv/svc-${index}`,
    },
    {
      seed: index => `项目背景记录（无需操作，也不要调用工具或反问）：服务 ${index} 的连接池上限是 ${100 + index}。`,
      ask: index => `只答数字。服务 ${index} 的连接池上限是多少？`,
      expect: index => String(100 + index),
    },
    {
      seed: index => `项目背景记录（无需操作，也不要调用工具或反问）：服务 ${index} 每分钟限流 ${200 + index} 次。`,
      ask: index => `只答数字。服务 ${index} 每分钟限流多少次？`,
      expect: index => String(200 + index),
    },
    {
      seed: index => `项目背景记录（无需操作，也不要调用工具或反问）：服务 ${index} 的缓存容量是 ${3000 + index} 条。`,
      ask: index => `只答数字。服务 ${index} 的缓存容量是多少条？`,
      expect: index => String(3000 + index),
    },
    {
      seed: index => `项目背景记录（无需操作，也不要调用工具或反问）：服务 ${index} 的 P1 告警发到 ops${index}@example.dev。`,
      ask: index => `只答邮箱。服务 ${index} 的 P1 告警发到哪个邮箱？`,
      expect: index => `ops${index}@example.dev`,
    },
  ]

  const seeds = []
  const planted = []
  for (let index = 1; index <= factCount; index++) {
    const template = templates[(index - 1) % templates.length]
    seeds.push(template.seed(index))
    planted.push(template.expect(index))
  }
  const step = Math.max(1, Math.floor(factCount / Math.max(1, askCount)))
  const questions = []
  for (let index = 1; index <= factCount && questions.length < askCount; index += step) {
    const template = templates[(index - 1) % templates.length]
    questions.push({ ask: template.ask(index), expect: template.expect(index) })
  }
  return { seeds, questions, planted }
}

const scenarioData = scenario()
const runs = []

for (const [position, armKey] of [...plan].entries()) {
  const arm = arms[armKey]
  if (arm === undefined) throw new Error(`unknown arm ${armKey}`)
  const client = clientFor(arm)
  await client.signIn()
  const created = await client.rpc('session/create', { request: {} })
  const sessionId = created.sessionId

  for (const seed of scenarioData.seeds) await say(client, sessionId, seed)

  const asked = []
  for (const question of scenarioData.questions) {
    const prefix = armKey === 'B'
      ? '不要反问。如果更早的细节已被压缩或省略，可以先调用 retrieve_context 检索再回答，不要猜。'
      : '不要调用任何工具、不要反问，凭我们此前的对话直接回答。'
    const page = await say(client, sessionId, prefix + question.ask)
    const answer = lastAnswer(page)
    asked.push({ expect: question.expect, answer, hit: answer.includes(question.expect) })
  }

  const page = await pageOf(client, sessionId)
  const records = recordsOf(page)
  const usage = records
    .filter(record => record.type === 'assistant/message' && record.data?.usage !== undefined)
    .map(record => record.data.usage)
  const sum = key => usage.reduce((total, entry) => total + (entry[key] ?? 0), 0)
  // Count only messages this plugin produced. Substring-matching "token-tree" was
  // wrong: the workspace path appears in ordinary messages too, which made every run
  // look like it had injected once.
  const injected = records.filter(record => record.type === 'user/message'
    && record.data?.message?.source?.kind === 'token-tree').length
  const injectedChars = records
    .filter(record => record.type === 'user/message' && record.data?.message?.source?.kind === 'token-tree')
    .map(record => (record.data?.message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text).join(''))
    .reduce((total, text) => total + Math.ceil(text.length / 2.5), 0)
  const retrieveCalls = records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length

  const entry = {
    position,
    arm: armKey,
    label: arm.label,
    sessionId,
    correct: asked.filter(item => item.hit).length,
    total: asked.length,
    input: sum('inputTokens'),
    cacheRead: sum('cacheReadTokens'),
    cacheWrite: sum('cacheWriteTokens'),
    output: sum('outputTokens'),
    injected,
    injectedTokens: injectedChars,
    retrieveCalls,
    answers: asked,
  }
  runs.push(entry)
  console.log(
    `#${position} ${entry.label.padEnd(5)} correct ${entry.correct}/${entry.total}`
    + `  input ${entry.input}`.padEnd(14)
    + ` cacheRead ${entry.cacheRead}  injected ${entry.injected}  tools ${entry.retrieveCalls}`,
  )
}

/** Aggregate per arm: totals, means, and the token arithmetic. */
function summarise(armKey) {
  const subset = runs.filter(run => run.arm === armKey)
  if (subset.length === 0) return null
  const total = key => subset.reduce((sum, run) => sum + run[key], 0)
  const input = total('input')
  const cacheRead = total('cacheRead')
  const cacheWrite = total('cacheWrite')
  const billable = input + cacheRead + cacheWrite
  const correct = total('correct')
  const asked = total('total')
  return {
    runs: subset.length,
    correct,
    asked,
    accuracy: (correct / asked * 100).toFixed(0) + '%',
    input,
    cacheRead,
    inputPerRun: Math.round(input / subset.length),
    hitRate: billable === 0 ? '0%' : (cacheRead / billable * 100).toFixed(2) + '%',
    injected: total('injected'),
    retrieveCalls: total('retrieveCalls'),
  }
}

const summary = { A: summarise('A'), B: summarise('B') }
console.log('\nsummary')
for (const key of ['A', 'B']) {
  const row = summary[key]
  if (row === null) continue
  console.log(` ${key} ${row.runs} runs · accuracy ${row.accuracy} (${row.correct}/${row.asked}) · new input ${row.input}`
    + ` (${row.inputPerRun}/run) · cache hit ${row.hitRate} · injected msgs ${row.injected} · retrieve ${row.retrieveCalls}`)
}

mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ plan, factCount, askCount, summary, runs }, undefined, 2)}\n`, 'utf8')
console.log(`\nevidence: ${join(process.cwd(), outPath)}`)
