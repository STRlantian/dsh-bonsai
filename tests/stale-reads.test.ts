import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { Config } from '../src/plugin/config.ts'
import { TokenTreeService } from '../src/plugin/service.ts'

const logger = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }

function service() {
  const config = Config['~standard'].validate({ logEdgeUpdates: false }).value
  return new TokenTreeService({ config, logger })
}

/** Feed a tool call the way the host records it. */
function toolCall(run, name, filePath, at) {
  run.service.handleEvent(run.session, {
    type: 'tool/call',
    seq: ++run.seq,
    time: at,
    data: { callId: 'c' + run.seq, name, arguments: JSON.stringify({ file_path: filePath }) },
  })
}

test('a file read and then changed elsewhere is reported in the hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bonsai-stale-'))
  const file = join(dir, 'notes.md')
  writeFileSync(file, 'first version')
  const run = { service: service(), seq: 0, session: { id: 'stale-session', snapshotEvents: () => [] } }

  const readAt = Date.now()
  toolCall(run, 'read', file, readAt)

  // Change it outside the filesystem tools, with a later mtime.
  writeFileSync(file, 'second version, changed elsewhere')
  utimesSync(file, new Date(readAt + 5000), new Date(readAt + 5000))

  const stale = run.service.staleReads('stale-session')
  assert.equal(stale.length, 1, 'the file is stale')
  const hint = run.service.retrievalHint('stale-session')
  assert.ok(hint !== undefined, 'a hint is produced')
  assert.ok(hint.includes('notes.md'), 'and it names the file: ' + hint)
  assert.ok(hint.includes('重读'), 'with the remedy')

  // Once this session writes it, the context is current again.
  toolCall(run, 'write', file, Date.now() + 9000)
  assert.equal(run.service.staleReads('stale-session').length, 0, 'a write by the session clears it')
})

test('an unchanged file stays out of the hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bonsai-fresh-'))
  const file = join(dir, 'notes.md')
  writeFileSync(file, 'stable')
  const run = { service: service(), seq: 0, session: { id: 'fresh-session', snapshotEvents: () => [] } }
  toolCall(run, 'read', file, Date.now() + 1000)
  assert.equal(run.service.staleReads('fresh-session').length, 0)
})
