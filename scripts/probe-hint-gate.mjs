#!/usr/bin/env node
/**
 * In-process check of the hint gate and tokenizer state.
 *
 * Reproduces what the host should do, without HTTP or a model: build the service with the
 * shipping defaults, feed it a conversation-sized message list, and print the decision plus
 * the tokenizer/ratio/drift state the settings route would report.
 *
 * Usage: node scripts/probe-hint-gate.mjs
 */
import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: message => console.log('[info]', message), warn: message => console.log('[warn]', message), debug: () => {}, error: message => console.log('[error]', message) }
const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
const service = new TokenTreeService({ config, logger })

const message = (id, text) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const short = [message('m1', '用一句话说明什么是写时复制。')]
console.log('\nshort context →', service.retrievalHint('probe', short) ?? '(no hint)')
console.log('state:', JSON.stringify(service.settingsInfo().tokenizer), JSON.stringify(service.ratioInfo()))

// Now a long context: 40 messages of prose, enough to cross the 12k threshold.
const long = []
for (let index = 0; index < 40; index++) {
  long.push(message(`L${index}`, `第 ${index} 段背景：这一段描述了服务 svc-${index} 的部署目录、连接池上限、限流阈值与灰度比例，`
    + '以及这些参数在压测中出现过的偏差和处理方式，写得比较啰嗦，目的是让上下文真实地变长。'))
}
const counted = service.contextTokens('probe', long)
console.log(`\nlong context: counted ${counted} tok`)
console.log('long context →', (service.retrievalHint('probe', long) ?? '(no hint)').slice(0, 60), '…')
console.log('state:', JSON.stringify(service.settingsInfo().tokenizer), JSON.stringify(service.ratioInfo()))
