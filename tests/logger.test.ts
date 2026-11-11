import test from 'node:test'
import assert from 'node:assert/strict'

import { exportToStdout, formatLogLine, stdoutExporter } from '../src/plugin/logger.ts'
import type { LoggerExporterOptionsLike, LoggerLike } from '../src/plugin/dsh.ts'

test('formatLogLine renders printf conversions and trailing arguments', () => {
  const line = formatLogLine({
    ts: Date.UTC(2026, 0, 2, 3, 4, 5, 678),
    type: 'info',
    name: 'dsh-bonsai',
    args: ['%s cost %d%% %o', 'edge', 42, { ok: true }, 'extra'],
  })
  assert.match(line, /^03:04:05\.678 INFO  dsh-bonsai edge cost 42% \{"ok":true\} "extra"$/)
})

test('formatLogLine handles a non-string first argument', () => {
  const line = formatLogLine({ ts: 0, type: 'warn', name: 'x', args: [{ a: 1 }] })
  assert.match(line, /WARN  x \{"a":1\}$/)
})

test('stdoutExporter writes one newline-terminated line to the provided sink', () => {
  const lines: string[] = []
  const exporter = stdoutExporter({ write: line => lines.push(line) })
  exporter.export({ ts: 1_000, type: 'debug', name: 'dsh-bonsai', args: ['hello %s', 'world'] })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /DEBUG dsh-bonsai hello world\n$/)
})

test('exportToStdout installs the exporter on a host logger', () => {
  let options: LoggerExporterOptionsLike | undefined
  const logger: LoggerLike = {
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
    exporter: value => { options = value },
  }
  exportToStdout(logger, { write: () => {} })
  assert.ok(options !== undefined)
  assert.equal(options.colors, false)
  assert.equal(options.levels?.default, 3)
  assert.equal(typeof options.export, 'function')
})
