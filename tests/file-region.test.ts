import test from 'node:test'
import assert from 'node:assert/strict'

import { FileRegion, digestOf } from '../src/plugin/file-region.ts'

/** Rough token counter: one token per four characters, enough for budget arithmetic. */
const count = text => Math.ceil(text.length / 4)

test('a digest keeps the head and says how much is missing', () => {
  const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n')
  const digest = digestOf(text, 20, count)
  assert.ok(count(digest) <= 30, 'the digest respects the budget')
  assert.ok(digest.startsWith('line 0'), 'it keeps the head')
  assert.ok(digest.includes('40 lines total'), 'and reports the size')
})

test('auto returns the whole file when it fits and a digest when it does not', () => {
  const region = new FileRegion()
  const small = 'alpha beta gamma\nshort file about gamma'
  const large = Array.from({ length: 400 }, (_, index) => `row ${index} alpha beta`).join('\n')
  region.record('/repo/small.md', small, 1000, 1000, count)
  region.record('/repo/large.md', large, 1000, 1000, count)

  const roomy = region.lookup('alpha beta gamma', 500, 'auto', count)
  assert.equal(roomy.length, 2, 'both files match')
  assert.ok(roomy.some(hit => hit.path.endsWith('small.md') && hit.complete), 'the small file comes whole')

  const tight = region.lookup('alpha beta', 40, 'auto', count)
  const largeHit = tight.find(hit => hit.path.endsWith('large.md'))
  const smallHit = tight.find(hit => hit.path.endsWith('small.md'))
  assert.ok(smallHit !== undefined && smallHit.complete, 'the small file still fits whole')
  assert.ok(largeHit !== undefined && !largeHit.complete, 'the large one is cut to a digest')
  assert.ok(tight.reduce((sum, hit) => sum + hit.tokens, 0) <= 40, 'and the total stays inside the budget')
})

test('off returns nothing, digest always digests, content always returns text', () => {
  const region = new FileRegion()
  region.record('/repo/a.ts', 'export function alpha() {}', 1, 1, count)
  assert.equal(region.lookup('alpha', 500, 'off', count).length, 0, 'off is silent')

  const digest = region.lookup('alpha', 500, 'digest', count)
  assert.equal(digest.length, 1)
  assert.equal(digest[0].complete, true, 'a one-line file is its own digest')

  const content = region.lookup('alpha', 4, 'content', count)
  assert.equal(content[0].complete, true, 'content ignores the budget for the first hit')
})

test('a file the session wrote is forgotten', () => {
  const region = new FileRegion()
  region.record('/repo/a.ts', 'alpha', 1, 1, count)
  assert.equal(region.size, 1)
  region.forget('/repo/a.ts')
  assert.equal(region.size, 0, 'the cached text is dropped')
  assert.equal(region.lookup('alpha', 500, 'content', count).length, 0)
})

test('a query with no shared terms does not pull a file in', () => {
  const region = new FileRegion()
  region.record('/repo/a.ts', 'export function alpha() {}', 1, 1, count)
  assert.equal(region.lookup('unrelated question about cooking', 500, 'auto', count).length, 0)
})
