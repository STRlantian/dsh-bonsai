#!/usr/bin/env node
/** Why does the follow-up case score what it scores? Prints the gate inputs per candidate. */
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'
import { contentFeatures, cosine, embedText } from '../src/core/embedding.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
const events = []
const session = { id: 's', snapshotEvents: () => events }
let seq = 0
const push = (type, data) => {
  const event = { type, seq: ++seq, time: seq, data }
  events.push(event)
  service.handleEvent(session, event)
}
const ask = text => push('user/message', { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', id: `q${seq}` })
const tell = text => push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text }] } })

ask('用三句话介绍凸包，不要调用工具。')
tell('凸包是包含给定点集的最小凸集，可以想象成一根橡皮筋把所有点绷紧后形成的边界。它的顶点一定来自点集本身。')
const question = '用一句话介绍凸包的时间复杂度。'
const state = service.stateOf('s')
const embedding = embedText(question)
const context = service.attachmentContext(state, question, embedding)
console.log('nodeCount', context.nodeCount, 'maxIdf', context.maxIdf.toFixed(3))
for (const node of state.tree.nodes.values()) {
  const features = contentFeatures(node.content)
  const shared = [...context.questionFeatures].filter(feature => features.has(feature))
  const parts = shared.map(feature => `${feature}:idf=${(context.idf.get(feature) ?? 0).toFixed(2)}/df=${context.documentFrequency.get(feature) ?? 0}`)
  console.log(`${node.id} ${node.kind.padEnd(9)} score=${service.attachmentScore(context, node).toFixed(3)} semantic=${Math.max(0, cosine(embedding, node.embedding)).toFixed(3)} shared=[${parts.join(' ')}]`)
}
