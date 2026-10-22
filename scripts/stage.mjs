#!/usr/bin/env node
/**
 * Stage a self-contained copy of the plugin for `link:` installation.
 *
 * Why this exists: a profile `link:` makes its target a *linked root*, and the
 * resolver scans that root as a workspace. Linking this repository root put the
 * `harness/` checkout inside that scan, so the app tried to load the unbuilt DSH
 * sources instead of the installed packages and failed to start. The staged
 * directory contains only the published package files, so linking it is safe.
 *
 * Usage:
 *   node scripts/stage.mjs           # build if needed, then refresh plugin/
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const target = join(root, 'plugin')

// Always stage from a fresh build: the manifest entry point is dist/index.js.
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { cwd: root, stdio: 'inherit' })
if ((build.status ?? 1) !== 0) process.exit(build.status ?? 1)

for (const required of ['dist', 'lib', 'cordis']) {
  if (!existsSync(join(root, required))) {
    console.error(`dsh-bonsai: stage requires ${required}/; run the build first`)
    process.exit(1)
  }
}

// The client module registry refuses a package that declares `dsh.client` without
// a readable bundle, and that refusal fails host startup — so never stage a
// package without it.
const clientBundle = join(root, 'lib', 'client.js')
if (!existsSync(clientBundle)) {
  console.error('dsh-bonsai: lib/client.js is missing; refusing to stage a package that would break boot')
  process.exit(1)
}
if (!readFileSync(clientBundle, 'utf8').includes('window.__ModuleLoader__.load(')) {
  console.error('dsh-bonsai: lib/client.js is not a client bundle; refusing to stage it')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
writeFileSync(join(target, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
for (const entry of ['dist', 'lib', 'cordis']) {
  cpSync(join(root, entry), join(target, entry), { recursive: true })
}
if (existsSync(join(root, 'README.md'))) copyFileSync(join(root, 'README.md'), join(target, 'README.md'))

console.log(`dsh-bonsai: staged ${target}`)
console.log('Prefer the copy install (no linked root; the profile cannot scan this repository):')
console.log('  & "<desktop>\\resources\\runtime\\cli\\bin\\dsh.cmd" plugin --profile desktop add "file:D:\\dsh-token-tree\\plugin"')
console.log('After editing sources: node scripts/stage.mjs, then repeat the add to refresh the copy.')
