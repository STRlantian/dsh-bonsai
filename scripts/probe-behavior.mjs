#!/usr/bin/env node
/**
 * A live behaviour check: does a follow-up come back, does an unrelated question branch, and
 * does folding engage once the threshold is crossed?
 *
 * Script: T1 introduces a topic, T2 asks something unrelated, T3 returns to the first topic.
 * Then the tree is read back to check the three parents, and folding is switched on with a low
 * threshold to see the prompt stop growing.
 *
 * Usage: node scripts/probe-behavior.mjs --port 19901 --token <token>
 */
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? fallback : args[index + 1]
}
const port = Number(argOf('port', '19901'))
const token = argOf('token', '')
const outPath = argOf('out', 'docs/experiments/behavior.json')
const threshold = Number(argOf('threshold', '3000'))
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

async function say(sessionId, text) {
  const before = lastSeq(await pageOf(sessionId))
  await rpc('session/prompt', {
    request: { requestId: crypto.randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' },
  })
  for (let waited = 0; waited < 300; waited++) {
    await new Promise(resolve => setTimeout(resolve, 500))
    const page = await pageOf(sessionId)
    if (recordsOf(page).some(record => (record.seq ?? 0) > before && record.type === 'turn/end')) {
      await new Promise(resolve => setTimeout(resolve, 1200))
      return pageOf(sessionId)
    }
  }
  throw new Error('turn did not finish')
}

const billed = page => {
  const usage = recordsOf(page).filter(record => record.type === 'assistant/message' && record.data?.usage).map(record => record.data.usage)
  const last = usage[usage.length - 1]
  return last === undefined ? 0 : (last.inputTokens ?? 0) + (last.cacheReadTokens ?? 0) + (last.cacheWriteTokens ?? 0)
}

// A low threshold, so folding has to engage inside a small experiment.
await post('/api/token-tree/settings', { foldAboveTokens: threshold, foldKeepTurns: 1, foldScope: 'turns', toolDeny: null })
console.log('settings:', JSON.stringify((await settings()).overrides))

const sessionId = (await rpc('session/create', { request: {} })).sessionId
const prompts = []
prompts.push(billed(await say(sessionId, '用三句话介绍凸包，不要调用工具。')))
prompts.push(billed(await say(sessionId, '用三句话介绍 osu mania 的判定区间，不要调用工具。')))
prompts.push(billed(await say(sessionId, '凸包的时间复杂度是多少？一句话，不要调用工具。')))

const tree = await (await fetch(`${base}/api/token-tree/tree?session=${sessionId}&view=nodes`, { headers: { cookie } })).json()
const questions = (tree.nodes ?? []).filter(node => node.kind === 'question')
const byParent = questions.map(node => {
  const parent = (tree.nodes ?? []).find(candidate => candidate.id === node.parentId)
  return { id: node.id, text: (node.preview ?? '').slice(0, 24), parentId: node.parentId, parentKind: parent?.kind, parentPreview: (parent?.preview ?? '').slice(0, 24) }
})

const state = await settings()
console.log('\ntree:')
for (const row of byParent) console.log(`  ${row.id} "${row.text}" → ${row.parentId} (${row.parentKind}: ${row.parentPreview})`)
console.log(`\nprompts: ${prompts.join(' → ')}`)
console.log(`fold: ${JSON.stringify(state.fold)}`)

await post('/api/token-tree/settings', { foldAboveTokens: null, foldKeepTurns: null, foldScope: null })
mkdirSync('docs/experiments', { recursive: true })
writeFileSync(outPath, `${JSON.stringify({ sessionId, prompts, questions: byParent, fold: state.fold }, undefined, 2)}\n`, 'utf8')
console.log(`evidence: ${outPath}`)
