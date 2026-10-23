#!/usr/bin/env node
/**
 * Score the suite's follow-up case with the real service, so thresholds can be chosen from the
 * numbers the tests actually see rather than from hand-written samples.
 */
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { embedText } from '../src/core/embedding.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
const sessionId = 'probe'
const session = { id: sessionId, snapshotEvents: () => events }
const events = []
let seq = 0

const push = (type, data) => {
  const event = { type, seq: ++seq, time: seq, data }
  events.push(event)
  service.handleEvent(session, event)
}

const ask = text => push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `q${seq}` })
const tell = text => push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })

ask('向我介绍线段树，不要太长')
tell('线段树是一棵二叉树，每个节点代表数组的一个区间，支持区间查询与区间修改，复杂度 O(log n)。')
ask('介绍如何编写 daw 的 vst，简单介绍')
tell('编写 DAW 插件（VST）入门：先区分 VST 与宿主，再选 JUCE 框架，实现 processBlock 处理音频。')

const state = service.stateOf(sessionId)
const tree = state.tree
const question = '向我介绍可持续化线段树'
const embedding = embedText(question)
const context = service.attachmentContext(state, question, embedding)
const currentId = tree.currentId
console.log(`current ${currentId} (${tree.node(currentId).kind}) = ${service.attachmentScore(context, tree.node(currentId)).toFixed(3)}`)
for (const node of tree.nodes.values()) {
  if (node.kind !== 'answer' || node.id === currentId) continue
  console.log(`answer ${node.id} = ${service.attachmentScore(context, node).toFixed(3)} · ${(node.summary ?? node.content).slice(0, 30)}`)
}
