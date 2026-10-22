#!/usr/bin/env node
/**
 * Increment the test-channel version.
 *
 * `0.1.1-test.0` → `0.1.1-test.1`. Releasing a build to the `test` dist-tag needs a version
 * npm has not seen before, so this runs before each test publish.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const path = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(path, 'utf8'))

const match = /^(\d+\.\d+\.\d+)-test\.(\d+)$/.exec(pkg.version)
if (match === null) {
  console.error(`package.json version "${pkg.version}" is not a test version (expected x.y.z-test.N)`)
  process.exit(1)
}

pkg.version = `${match[1]}-test.${Number(match[2]) + 1}`
writeFileSync(path, `${JSON.stringify(pkg, undefined, 2)}\n`, 'utf8')
console.log(pkg.version)
