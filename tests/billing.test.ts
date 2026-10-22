import test from 'node:test'
import assert from 'node:assert/strict'

import { BillingFit, classCounts } from '../src/core/billing.ts'

test('classCounts separates wide and narrow characters', () => {
  const counts = classCounts('备份窗口 03:15')
  assert.equal(counts.wide, 4)
  assert.equal(counts.narrow, 6)
})

test('the billing fit starts from priors and improves as prompts vary', () => {
  const fit = new BillingFit()
  // Priors before any observation: CJK 0.6 tok/char, Latin 0.2.
  const before = fit.coefficients()
  assert.equal(before.wide, 0.6)
  assert.equal(before.narrow, 0.2)

  // A model that charges 0.5 tok/CJK-char and 0.25 tok/Latin-char, with 3,000 tokens of
  // fixed system prompt. Prompts of varying shape are what lets the fit separate them.
  const truth = { wide: 0.5, narrow: 0.25, overhead: 3_000 }
  const shapes = [
    { wide: 200, narrow: 400 },
    { wide: 900, narrow: 300 },
    { wide: 400, narrow: 2_000 },
    { wide: 1_500, narrow: 800 },
    { wide: 300, narrow: 5_000 },
    { wide: 2_400, narrow: 1_200 },
  ]
  for (const shape of shapes) {
    fit.observe(shape.wide, shape.narrow, truth.wide * shape.wide + truth.narrow * shape.narrow + truth.overhead)
  }

  const after = fit.coefficients()
  assert.ok(Math.abs(after.wide - truth.wide) < 0.05, `wide ${after.wide}`)
  assert.ok(Math.abs(after.narrow - truth.narrow) < 0.05, `narrow ${after.narrow}`)
  assert.ok(Math.abs(after.overhead - truth.overhead) < 200, `overhead ${after.overhead}`)

  // Estimating new text excludes the overhead, which never enters the tree.
  const estimate = fit.estimate('备份窗口固定在 03:15')
  const expected = Math.round(classCounts('备份窗口固定在 03:15').wide * truth.wide
    + classCounts('备份窗口固定在 03:15').narrow * truth.narrow)
  assert.equal(estimate, expected)
})

test('a degenerate fit keeps positive coefficients', () => {
  const fit = new BillingFit()
  // Every prompt the same size and shape: the system is under-determined, priors carry it.
  for (let index = 0; index < 6; index++) fit.observe(100, 100, 5_000)
  const coefficients = fit.coefficients()
  assert.ok(coefficients.wide > 0)
  assert.ok(coefficients.narrow > 0)
  assert.ok(coefficients.overhead >= 0)
})
