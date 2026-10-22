#!/usr/bin/env node
/**
 * Compile the plugin with TypeScript.
 *
 * Resolution order for the compiler:
 *   1. the project's own devDependency (`node_modules/typescript`), the normal
 *      case after `pnpm install`;
 *   2. the reference checkout under `harness/node_modules/typescript`, used on
 *      machines without registry access where the monorepo checkout is the only
 *      available toolchain.
 *
 * Extra CLI arguments are forwarded to tsc, so `node scripts/build.mjs --noEmit`
 * type-checks without emitting.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const local = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const vendored = join(root, 'harness', 'node_modules', 'typescript', 'bin', 'tsc')

let tsc
let typesFallback
if (existsSync(local)) {
  tsc = local
} else if (existsSync(vendored)) {
  tsc = vendored
  typesFallback = join(root, 'harness', 'node_modules', '@types')
} else {
  console.error('dsh-bonsai: no TypeScript compiler found.')
  console.error('Run `pnpm install` in this directory, or keep the reference checkout at ./harness.')
  process.exit(1)
}

const args = [tsc, '-p', join(root, 'tsconfig.json'), ...process.argv.slice(2)]
if (typesFallback !== undefined && !args.includes('--typeRoots')) {
  args.push('--typeRoots', typesFallback)
}
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)

// The browser half is a hand-written closure-factory artifact: TypeScript never
// sees it, and it must reach the paths `exports["./client"]` names. Publish it
// beside the compiled host code and under `lib/` for the client module registry.
if (!process.argv.includes('--noEmit')) {
  const source = join(root, 'client', 'client.js')
  if (existsSync(source)) {
    for (const target of [join(root, 'dist', 'client.js'), join(root, 'lib', 'client.js')]) {
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(source, target)
    }
    console.log('dsh-bonsai: published client bundle to dist/client.js and lib/client.js')
  }
}
process.exit(0)
