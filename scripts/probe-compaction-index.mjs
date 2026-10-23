#!/usr/bin/env node
/** Render the post-compaction index so its wording can be reviewed. */
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })
const state = service.stateOf('demo')
for (const [index, text] of [
  '备份窗口每天 03:15，保留 14 天。',
  '错误码从 41000 开始，每个模块占 100。',
  '探针超时是 1733ms，超过就回滚。',
].entries()) {
  state.tree.addNode({ kind: 'question', content: text, timestamp: index })
}
service.noteCompactionObserved('demo')
console.log(service.retrievalHint('demo'))
