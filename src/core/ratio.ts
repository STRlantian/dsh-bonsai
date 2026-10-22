/**
 * Where the token count comes from.
 *
 * Two things are true at once:
 *
 * 1. A real tokenizer is exact, and the plugin now has one. Nothing beats it.
 * 2. Counting the whole conversation on every step is wasteful (200k characters costs
 *    ~250 ms), and a single characters-per-token constant is simply wrong: CJK runs
 *    around 1.6 characters per token, English prose around 5.8.
 *
 * So this module keeps a **learned two-class ratio** — tokens ≈ a·wide + b·narrow, where
 * wide counts CJK and full-width code points and narrow counts everything else. It is
 * fitted online by least squares against the real tokenizer's answers, so it improves as
 * a session is used. It is only ever used to *skip* work: when the cheap estimate is far
 * below a threshold, no exact count is needed. Exact numbers always win when they are
 * affordable, because a budget decision is about money.
 *
 * @module dsh-bonsai/core/ratio
 */

/** Count wide (CJK and full-width) and narrow code points. */
function classes(text: string): { wide: number; narrow: number } {
  let wide = 0
  let narrow = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (code >= 0x2e80) wide++
    else narrow++
  }
  return { wide, narrow }
}

/**
 * Least-squares fit of "tokens per wide character" and "tokens per narrow character".
 *
 * Holds running sums of the 2×2 normal equations, so each observation is O(1) and the
 * fit can be read at any time. A small ridge term keeps it stable before there is data,
 * and the priors (CJK ≈ 0.6 tok/char, Latin ≈ 0.2) are the published ratios this tokenizer
 * family shows in practice.
 */
export class TokenRatio {
  private sww = 0
  private swn = 0
  private snn = 0
  private swt = 0
  private snt = 0
  private samples = 0
  private readonly ridge: number

  constructor(ridge = 1) {
    this.ridge = ridge
  }

  /**
   * Learn from one text whose exact token count is known.
   * @param text - the sampled text.
   * @param tokens - the exact count from the tokenizer.
   */
  observe(text: string, tokens: number): void {
    if (text.length === 0 || tokens <= 0) return
    const { wide, narrow } = classes(text)
    this.sww += wide * wide
    this.swn += wide * narrow
    this.snn += narrow * narrow
    this.swt += wide * tokens
    this.snt += narrow * tokens
    this.samples++
  }

  /**
   * Current coefficients.
   * @returns Tokens per wide and per narrow character, with priors applied.
   */
  coefficients(): { wide: number; narrow: number } {
    const priorWide = 0.6
    const priorNarrow = 0.2
    const a11 = this.sww + this.ridge
    const a12 = this.swn
    const a22 = this.snn + this.ridge
    const b1 = this.swt + this.ridge * priorWide
    const b2 = this.snt + this.ridge * priorNarrow
    const determinant = a11 * a22 - a12 * a12
    if (Math.abs(determinant) < 1e-9) return { wide: priorWide, narrow: priorNarrow }
    const wide = (b1 * a22 - b2 * a12) / determinant
    const narrow = (a11 * b2 - a12 * b1) / determinant
    // A negative coefficient is nonsense; fall back to the prior for that class.
    return {
      wide: wide > 0 ? wide : priorWide,
      narrow: narrow > 0 ? narrow : priorNarrow,
    }
  }

  /**
   * Cheap token estimate from the learned ratio.
   * @param text - text to estimate.
   * @returns Estimated tokens (at least 1 for non-empty text).
   */
  estimate(text: string): number {
    if (text.length === 0) return 0
    const { wide, narrow } = classes(text)
    const { wide: perWide, narrow: perNarrow } = this.coefficients()
    return Math.max(1, Math.round(wide * perWide + narrow * perNarrow))
  }

  /** How many observations the fit is based on. */
  get observations(): number {
    return this.samples
  }
}
