#!/usr/bin/env node
/**
 * Refuse a release that could install stdout debug logging.
 *
 * The exporter itself is fine; the danger is a build that flips `debugMode` on or reads an environment
 * switch at startup. This gate runs after the build (and after staging, when a staged package exists),
 * so it inspects the bytes that would actually reach npm.
 *
 * Usage: node scripts/check-release.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const explicit = process.argv.slice(2)
const candidates = explicit.length > 0
  ? explicit.map(file => resolve(file))
  : [join(root, 'plugin', 'dist', 'index.js'), join(root, 'dist', 'index.js')]

let checked = 0
for (const file of candidates) {
  if (!existsSync(file)) continue
  checked++
  const text = readFileSync(file, 'utf8')
  if (/debugMode\s*=\s*true\b/.test(text)) {
    throw new Error(`${file}: debugMode is hardcoded true`)
  }
  if (text.includes('DSH_BONSAI_LOG')) {
    throw new Error(`${file}: the DSH_BONSAI_LOG environment switch leaked into the published build`)
  }
  if (!/const debugMode = false\b/.test(text)) {
    throw new Error(`${file}: debugMode must be a literal false in the published build`)
  }
}

if (checked === 0) {
  throw new Error('no built dist/index.js found; run the build before checking the release')
}

console.log(`check-release: ${checked} build(s) have debugMode = false and no debug env switch`)
