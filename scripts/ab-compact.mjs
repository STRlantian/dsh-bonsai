#!/usr/bin/env node
/**
 * Post-compaction recall experiment.
 *
 * The question this answers: after history is compacted away, can the model still get
 * an early fact back — and does the tree make the difference? `/compact` is a manual
 * command (`ctx.compaction.compactNow`), so compaction no longer has to be provoked by
 * context pressure; the same session can be compacted on demand.
 *
 * Flow:
 *   1. seed a few turns containing distinctive facts;
 *   2. send `/compact` and report what the command answered;
 *   3. ask one question per fact (optionally allowed to call retrieve_context);
 *   4. print each answer, plus how many tool calls the tree saw.
 *
 * Usage:
 *   node scripts/ab-compact.mjs --port 19521 --token <token> --label baseline
 *   node scripts/ab-compact.mjs --port 19522 --token <token> --label tree --tools
 */
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const has = name => args.includes(`--${name}`)

const port = Number(argOf('port', '19521'))
const token = argOf('token', '')
const label = argOf('label', 'run')
const tools = has('tools')
const fillerCount = Number(argOf('filler', '6'))
const base = `http://127.0.0.1:${port}`
let cookie = ''

/** Turn the token URL into a session cookie. */
async function signIn() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const parts = setCookie.map(entry => entry.split(';')[0])
  if (parts.length === 0) throw new Error('no cookie from the token URL')
  cookie = parts.join('; ')
}

/** One gateway call. */
async function rpc(method, requestArgs) {
  const envelope = { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args: requestArgs } }
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await response.json()
  if (payload.result?.ok !== true) throw new Error(`${method}: ${payload.result?.error?.message ?? 'unknown error'}`)
  return payload.result.value
}

/** One page of records for a session. */
async function pageOf(sessionId) {
  const address = { kind: 'session', sessionId }
  try {
    return await rpc('session/page', { request: { address, throughSeq: Number.MAX_SAFE_INTEGER } })
  } catch (error) {
    const match = /past cursor (\d+)/.exec(error instanceof Error ? error.message : String(error))
    if (match === null) throw error
    return rpc('session/page', { request: { address, throughSeq: Number(match[1]) } })
  }
}

/** Records as `{type, seq, data}`, whatever envelope the page uses. */
function recordsOf(page) {
  return (page.records ?? []).map(record => record.event ?? record).filter(record => record?.type !== undefined)
}

const lastSeq = page => recordsOf(page).reduce((max, record) => Math.max(max, record.seq ?? 0), 0)

/** Send one message and wait until a turn ends. */
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
  for (let waited = 0; waited < 240; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    const records = recordsOf(page)
    const done = records.some(record => (record.seq ?? 0) > before && record.type === 'turn/end')
    if (done) return page
    // A clarifying question parks the turn forever; fail fast instead of hanging.
    const asked = records.find(record => (record.seq ?? 0) > before && record.type === 'tool/call' && record.data?.name === 'ask_user_question')
    if (asked !== undefined) throw new Error(`the agent asked a clarifying question: ${text.slice(0, 50)}`)
  }
  throw new Error(`turn did not finish: ${text.slice(0, 40)}`)
}

/** The text of the last assistant message in a page. */
function lastAnswer(page) {
  const messages = recordsOf(page).filter(record => record.type === 'assistant/message')
  const last = messages[messages.length - 1]
  if (last === undefined) return ''
  const content = last.data?.message?.content ?? []
  return content.filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
}

/**
 * Run one slash command through the gateway.
 *
 * `/compact` is not a prompt: sending it as message text makes the model answer it.
 * The command layer lives at `commands/execute` and takes the agent id plus the line.
 * @param {string} sessionId - session (agent) to run against.
 * @param {string} line - complete command line.
 * @returns {Promise<object>} the command outcome.
 */
async function runCommand(sessionId, line) {
  return rpc('commands/execute', { agentId: sessionId, line, submittedAttachments: [] })
}

/**
 * Generate a scalable fact set.
 *
 * Six templates instantiated with distinct numbers, so a large run has facts a summary
 * must actually drop rather than recite. Questions sample the generated facts evenly,
 * keeping the question bill far below the seeding bill.
 * @param {number} count - how many facts to seed.
 * @param {number} asked - how many of them to ask about.
 * @returns {{facts: string[], questions: {ask: string, expect: string}[]}} scenario.
 */
function scenario(count, asked) {
  const templates = [
    {
      text: index => `服务 ${index} 的部署目录是 /srv/svc-${index}，配置只读挂载，日志软链到 /var/log/svc-${index}。`,
      ask: index => `只答目录。服务 ${index} 的部署目录是什么？`,
      expect: index => `/srv/svc-${index}`,
    },
    {
      text: index => `服务 ${index} 的连接池上限配成 ${100 + index}，空闲回收 30 秒，超时抛 ${40000 + index}。`,
      ask: index => `只答数字。服务 ${index} 的连接池上限是多少？`,
      expect: index => String(100 + index),
    },
    {
      text: index => `服务 ${index} 的限流是每分钟 ${200 + index} 次，突发容量 ${5 + (index % 7)}。`,
      ask: index => `只答数字。服务 ${index} 每分钟限流多少次？`,
      expect: index => String(200 + index),
    },
    {
      text: index => `服务 ${index} 的灰度比例每阶 ${1 + (index % 9)}%，观察 6 小时，回滚阈值 2%。`,
      ask: index => `只答百分比。服务 ${index} 每阶灰度是多少？`,
      expect: index => `${1 + (index % 9)}%`,
    },
    {
      text: index => `服务 ${index} 的缓存容量 ${3000 + index} 条，写回延迟 5 秒，命中率目标 92%。`,
      ask: index => `只答数字。服务 ${index} 的缓存容量是多少条？`,
      expect: index => String(3000 + index),
    },
    {
      text: index => `服务 ${index} 的告警路由：P0 电话，P1 邮件到 ops${index}@example.dev。`,
      ask: index => `只答邮箱。服务 ${index} 的 P1 告警发到哪个邮箱？`,
      expect: index => `ops${index}@example.dev`,
    },
  ]

  const facts = []
  const step = Math.max(1, Math.floor(count / Math.max(1, asked)))
  for (let index = 1; index <= count; index++) {
    const template = templates[(index - 1) % templates.length]
    facts.push(template.text(index))
  }
  const questions = []
  for (let index = 1; index <= count && questions.length < asked; index += step) {
    const template = templates[(index - 1) % templates.length]
    questions.push({ ask: template.ask(index), expect: template.expect(index) })
  }
  return { facts, questions }
}

const factCount = Number(argOf('facts', '5'))
const askCount = Number(argOf('ask', '5'))
const generated = scenario(factCount, askCount)
const facts = generated.facts
const questions = generated.questions

// Filler turns only need to consume context; anything that reads like "carry on with
// work" makes the agent ask what to do next, which parks the turn.
const filler = [
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：第一阶段已完成。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：日志已归档。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：会议已顺延。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：值班表已更新。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：周报已提交。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：巡检已完成。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：文档已同步。',
  '这是一条无关紧要的填充说明，不需要任何操作，只回复「收到」：批处理已结束。',
]

const prefix = tools
  ? '不要反问、不要请求确认。如果更早的细节已被压缩或省略，可以先调用 retrieve_context 检索再回答，不要猜。'
  : '不要调用任何工具、不要反问、不要请求确认，凭我们此前的对话直接回答。'

// Seeding must not look like a task, or the agent replies with a clarifying question
// and the turn never ends.
const seedPrefix = '以下是一条项目背景记录，不需要任何操作，也不要调用工具或反问，只回复「收到」。'

await signIn()
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
console.log(`[${label}] session ${sessionId}`)

for (const fact of facts) {
  const page = await say(sessionId, seedPrefix + fact)
  console.log(`  seed → ${lastAnswer(page).slice(0, 40)}`)
}

// Push the facts out of the retained tail, so compaction really shadows them.
for (let index = 0; index < fillerCount; index++) {
  await say(sessionId, filler[index % filler.length])
}
console.log(`[${label}] filler turns: ${fillerCount}`)

const compactOutcome = await runCommand(sessionId, '/compact')
const compactValue = compactOutcome?.result ?? {}
console.log(`[${label}] /compact → ${compactValue.kind}: ${compactValue.text}`)
if (compactValue.sourceEventSeq !== undefined) {
  console.log(`[${label}] summary seq: ${compactValue.sourceEventSeq}`)
}

const results = []
for (const question of questions) {
  const page = await say(sessionId, `${prefix}${question.ask}`)
  const answer = lastAnswer(page)
  const hit = answer.includes(question.expect)
  results.push({ expect: question.expect, answer, hit })
  console.log(`  Q ${question.expect}: ${hit ? 'HIT ' : 'MISS'} — ${answer.replace(/\s+/g, ' ').slice(0, 90)}`)
}

const page = await pageOf(sessionId)
const records = recordsOf(page)
const retrieveCalls = records.filter(record => record.type === 'tool/call' && record.data?.name === 'retrieve_context').length
const compactions = records.filter(record => record.type === 'compaction/end').length
const summary = `${results.filter(result => result.hit).length}/${results.length}`

console.log(`\n[${label}] recall after compact: ${summary}`)
console.log(`[${label}] compaction/end events seen in this page: ${compactions}`)
console.log(`[${label}] retrieve_context calls: ${retrieveCalls}`)
console.log(`[${label}] session id: ${sessionId}`)
