#!/usr/bin/env node
/**
 * Drive one dsh web host through a fixed conversation, over the public gateway.
 *
 * This is the A/B driver: it talks to `/api/session/*` exactly like the browser
 * client does, so the run is a real harness session — the tree plugin writes its
 * own nodes and the usage counters land in the session log for `bench-cache.mjs`.
 *
 * The prompt list mixes related follow-ups with deliberate jumps across topics: a
 * conversation that only ever stays on one subject never exercises the tree's
 * attachment decision, and one that only jumps never exercises retrieval.
 *
 * Usage:
 *   node scripts/ab-drive.mjs --port 19501 --token <token>
 *   node scripts/ab-drive.mjs --port 19501 --token <token> --turns 4 --label baseline
 */
const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}

const port = Number(argOf('port', '19501'))
const token = argOf('token', '')
const label = argOf('label', 'run')
const base = `http://127.0.0.1:${port}`

const recallQuestionsStrict = [
  '不要调用任何工具、不要读文件，凭我们的对话回答：数据库文件名是什么？只答文件名。',
  '不要调用任何工具、不要读文件，凭我们的对话回答：认证算法的时钟容差是多少秒？只答数字。',
  '不要调用任何工具、不要读文件，凭我们的对话回答：备份每天几点执行？只答时间。',
  '不要调用任何工具、不要读文件，凭我们的对话回答：错误码从哪个数字开始？只答数字。',
  '不要调用任何工具、不要读文件，凭我们的对话回答：连接池上限和限流分别是多少？一行答完。',
]

// Same questions, but retrieval is allowed and encouraged. Used with compaction on,
// where the early facts may only exist in the tree.
const recallQuestionsWithTools = [
  '如果更早的细节已被压缩或省略，可以调用 retrieve_context 检索后再答，不要猜。问题：数据库文件名是什么？只答文件名。',
  '如果更早的细节已被压缩或省略，可以调用 retrieve_context 检索后再答，不要猜。问题：认证算法的时钟容差是多少秒？只答数字。',
  '如果更早的细节已被压缩或省略，可以调用 retrieve_context 检索后再答，不要猜。问题：备份每天几点执行？只答时间。',
  '如果更早的细节已被压缩或省略，可以调用 retrieve_context 检索后再答，不要猜。问题：错误码从哪个数字开始？只答数字。',
  '如果更早的细节已被压缩或省略，可以调用 retrieve_context 检索后再答，不要猜。问题：连接池上限和限流分别是多少？一行答完。',
]

const recallFacts = [
  '不要调用任何工具、不要创建或修改任何文件。我告诉你一些项目信息，你只需要了解：项目代号是青松，版本 0.3。回复“了解”。',
  '不要调用任何工具、不要创建或修改任何文件。数据库用 SQLite，文件名 data/qingsong.db。回复“了解”。',
  '不要调用任何工具。接口前缀是 /api/v3。回复“了解”。',
  '不要调用任何工具。认证用 HMAC-SHA256，时钟容差 30 秒。回复“了解”。',
  '不要调用任何工具。部署目录是 /srv/qingsong。回复“了解”。',
  '不要调用任何工具。日志保留 14 天。回复“了解”。',
  '不要调用任何工具。缓存用内存 LRU，容量 512 条。回复“了解”。',
  '不要调用任何工具。限流是 60 次/分钟/IP。回复“了解”。',
  '不要调用任何工具。备份每天 03:15 执行。回复“了解”。',
  '不要调用任何工具。时区固定 Asia/Shanghai。回复“了解”。',
  '不要调用任何工具。前端是 Vue 3 + Vite。回复“了解”。',
  '不要调用任何工具。错误码从 40001 开始。回复“了解”。',
  '不要调用任何工具。关键告警发到 ops@qingsong.dev。回复“了解”。',
  '不要调用任何工具。数据库连接池上限 20。回复“了解”。',
]

const promptSets = {
  mixed: [
    '用一句话解释什么是哈希表。',
    '它的查询为什么平均是 O(1)？一句话。',
    '顺便问下，今天上海天气怎么样？一句话就行。',
    '回到哈希表：负载因子是什么意思？一句话。',
    '开放寻址法怎么解决冲突？一句话。',
    '换个话题，用一句话说说线段树是做什么的。',
    '线段树和树状数组有什么区别？一句话。',
    '把前面关于哈希表的结论合成三行，不要展开。',
  ],
  // Recall set: fourteen distinctive facts stated as conversation (not as an
  // instruction — "记一个事实" once made the agent write them into AGENTS.md), then
  // five questions that can only be answered from the early ones.
  recall: [...recallFacts, ...recallQuestionsStrict],
  // Same facts, but retrieval is allowed — the arm used when compaction is on.
  recallTools: [...recallFacts, ...recallQuestionsWithTools],
}

const setName = argOf('set', 'mixed')
const prompts = promptSets[setName]
if (prompts === undefined) {
  console.error(`ab-drive: unknown prompt set ${setName}`)
  process.exit(1)
}
const turns = Number(argOf('turns', String(prompts.length)))
// The recall set ends with its questions, so slicing from the front would cut them
// off; only the mixed set supports a shorter run.
const selected = setName === 'recall' ? prompts : prompts.slice(0, Math.min(turns, prompts.length))

if (token.length === 0) {
  console.error('ab-drive: --token is required')
  process.exit(1)
}

/** Cookie jar: one browser-session cookie is all this needs. */
let cookie = ''

/** Fetch the token URL once and remember the cookie it sets. */
async function signIn() {
  const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  const parts = setCookie.map(entry => entry.split(';')[0])
  if (parts.length === 0) throw new Error('ab-drive: the token URL did not set a cookie')
  cookie = parts.join('; ')
}

/** One gateway call. */
async function rpc(method, requestArgs) {
  const envelope = {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method,
    payload: { args: requestArgs },
  }
  const response = await fetch(`${base}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  const payload = await response.json()
  if (payload.result?.ok !== true) {
    throw new Error(`${method}: ${payload.result?.error?.message ?? 'unknown error'}`)
  }
  return payload.result.value
}

/**
 * Message list for a session.
 *
 * The page address needs a `throughSeq` that is not past the session's cursor, and
 * the cursor grows as the conversation does. Asking for the maximum and reading the
 * reported head keeps this driver free of seq bookkeeping: the error names the
 * cursor, so one retry is enough.
 * @param {string} sessionId - session to read.
 * @returns {Promise<{messages: unknown[]}>} the page.
 */
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

/** Keep one follow stream open so the agent actually drives the session. */
async function follow(sessionId) {
  const envelope = {
    type: 'client-request',
    rpcId: crypto.randomUUID(),
    method: 'session/follow',
    payload: { args: { request: { address: { kind: 'session', sessionId } } } },
  }
  const response = await fetch(`${base}/api/session/follow`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(envelope),
  })
  if (!response.ok || response.body === null) {
    throw new Error(`ab-drive: follow failed with HTTP ${response.status}`)
  }
  // Drain the stream in the background: the frames are not needed, only the fact
  // that a follower exists and keeps the session live. With --debug they are
  // printed, which is how a turn that never answers shows its real error.
  const debug = args.includes('--debug')
  ;(async () => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        if (!debug || value === undefined) continue
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.trim().length === 0) continue
          console.log(`[follow] ${line.slice(0, 400)}`)
        }
      }
    } catch {
      // A closed stream is the normal end of the run.
    }
  })()
  return response
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Highest event sequence present in one page.
 *
 * The page is a window, so counting `turn/end` records is not monotonic as the
 * session grows; the sequence number is.
 * @param {object} page - page value.
 * @returns {number} the newest sequence seen, or -1.
 */
function lastSeq(page) {
  let max = -1
  for (const record of Array.isArray(page?.records) ? page.records : []) {
    if (record?.type !== 'event') continue
    const seq = record.event?.seq
    if (typeof seq === 'number' && seq > max) max = seq
  }
  return max
}

/** Whether a `turn/end` newer than `after` is in this page. */
function endedAfter(page, after) {
  for (const record of Array.isArray(page?.records) ? page.records : []) {
    if (record?.type !== 'event') continue
    if (record.event?.type === 'turn/end' && typeof record.event.seq === 'number' && record.event.seq > after) return true
  }
  return false
}

/**
 * Round-trip one prompt and wait until the transcript grows.
 * @param {string} sessionId - session to drive.
 * @param {string} text - prompt text.
 * @returns {Promise<void>} resolves once the turn ended.
 */
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
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    await sleep(2000)
    const page = await pageOf(sessionId)
    if (endedAfter(page, before)) return
  }
  throw new Error('ab-drive: the turn did not finish within 240s')
}

await signIn()
const created = await rpc('session/create', { request: {} })
const sessionId = created.sessionId
await follow(sessionId)
console.log(`[${label}] session ${sessionId} (following)`)

let index = 0
for (const prompt of selected) {
  index += 1
  const started = Date.now()
  await say(sessionId, prompt)
  console.log(`[${label}] turn ${index}/${selected.length} ${((Date.now() - started) / 1000).toFixed(1)}s  ${prompt.slice(0, 40)}`)
}

// Print the tail of the transcript so a recall run can be judged without opening
// the UI: the last answers are what the comparison actually looks at.
const finalPage = await pageOf(sessionId)
const answers = []
for (const record of Array.isArray(finalPage?.records) ? finalPage.records : []) {
  if (record?.type !== 'event' || record.event?.type !== 'assistant/message') continue
  const message = record.event.data?.message ?? record.event.data
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  if (text.trim().length > 0) answers.push(text.trim())
}
const tail = answers.slice(-5)
console.log(`[${label}] answers ${JSON.stringify(tail)}`)
console.log(`[${label}] done ${sessionId}`)
