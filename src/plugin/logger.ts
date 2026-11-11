/**
 * A stdout exporter for the host logger.
 *
 * The host logger owns the sink; `ctx.logger.exporter()` is the supported way to receive every
 * formatted line. This module keeps the formatting and the stdout write in one place so a CLI or
 * a headless run can opt in without copying the printf-style adapter.
 *
 * @module dsh-token-tree/plugin/logger
 */

import type { LoggerExporterOptionsLike, LoggerLike, LoggerMessageLike } from './dsh.ts'

/** Options for {@link stdoutExporter}; the write hook is for tests. */
export interface StdoutExporterOptions {
  /** Whether the exporter may colour output; stdout output is plain text. */
  colors?: boolean
  /** Per-level verbosity passed through to the host. */
  levels?: Readonly<Record<string, number>>
  /** Receives the finished line, including its newline. Defaults to `process.stdout.write`. */
  write?: (line: string) => void
}

/**
 * Render one logger message as a single line.
 *
 * Supports the printf conversions the host and this plugin use (`%s`, `%d`, `%o`, `%O`); extra
 * arguments are appended as JSON. A formatter failure falls back to the raw arguments, because a
 * logging helper must never fail the operation it is observing.
 * @param message - logger line supplied by the host.
 * @returns The formatted line, without a trailing newline.
 */
export function formatLogLine(message: LoggerMessageLike): string {
  const args = Array.isArray(message.args) ? message.args : [message.args]
  const format = typeof args[0] === 'string' ? args[0] : '%o'
  const rest = args.slice(typeof args[0] === 'string' ? 1 : 0)
  let index = 0
  let body: string
  try {
    body = format.replace(/%[sdoO%]/g, token => {
      if (token === '%%') return '%'
      const value = rest[index++]
      if (token === '%d') return String(Number(value))
      if (token === '%s') return String(value)
      return JSON.stringify(value)
    })
    if (rest.length > index) body += ' ' + rest.slice(index).map(value => JSON.stringify(value)).join(' ')
  } catch {
    body = args.map(value => String(value)).join(' ')
  }
  const time = new Date(Number(message.ts)).toISOString().slice(11, 23)
  const level = String(message.type).toUpperCase().padEnd(5)
  return `${time} ${level} ${message.name} ${body}`
}

/**
 * Build a logger exporter that writes one plain-text line to stdout.
 * @param options - optional write hook and host passthrough fields.
 * @returns Options ready for `ctx.logger.exporter()`.
 */
export function stdoutExporter(options: StdoutExporterOptions = {}): LoggerExporterOptionsLike {
  const write = options.write ?? ((line: string) => { process.stdout.write(line) })
  return {
    colors: options.colors ?? false,
    levels: options.levels ?? { default: 3 },
    export(message) {
      try {
        write(formatLogLine(message) + '\n')
      } catch {
        // Logging must not break the turn, even when stdout is closed.
      }
    },
  }
}

/**
 * Install the stdout exporter on a host logger.
 * @param logger - host logger.
 * @param options - optional write hook and host passthrough fields.
 */
export function exportToStdout(logger: LoggerLike, options: StdoutExporterOptions = {}): void {
  logger.exporter(stdoutExporter(options))
}
