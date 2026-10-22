/**
 * Learn token counting from the bill.
 *
 * Closed-source models ship no `tokenizer.json`, and no plugin can carry a vocabulary per
 * provider. But every provider reports usage for every request, and that number is exact
 * by definition — so the counts can be *fitted* instead of fetched.
 *
 * The model of the prompt is:
 *
 *     billed ≈ a·wideChars + b·narrowChars + overhead
 *
 * where `overhead` absorbs the system prompt and tool definitions, which are large, are
 * not visible to a plugin, and are roughly constant within a session. Fitting all three
 * coefficients from the turns that have already happened separates the constant from the
 * text, which is what makes the estimates usable for a model we know nothing about.
 *
 * Fitted content coefficients `a` and `b` are then used to size nodes and conversations;
 * the overhead is deliberately excluded there because it never enters the tree.
 *
 * @module dsh-bonsai/core/billing
 */

/** One observation: a prompt of known shape and its billed size. */
interface Observation {
  wide: number
  narrow: number
  tokens: number
}

/**
 * Count wide (CJK/full-width) and narrow code points.
 * @param text - text to measure.
 * @returns Character class counts.
 */
export function classCounts(text: string): { wide: number; narrow: number } {
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
 * Three-coefficient least squares over prompt observations.
 *
 * Solved in closed form from running sums, so each observation is O(1) and the fit can be
 * read at any time. A ridge term anchored at weak priors keeps the solution sane before
 * there is enough variation to separate text from overhead: without variation (every turn
 * the same size) the three coefficients are under-determined, and the priors decide.
 */
export class BillingFit {
  private sww = 0
  private swn = 0
  private swn2 = 0
  private snn = 0
  private snn2 = 0
  private sww2 = 0
  // Right-hand sides: sums of (feature × tokens).
  private swt = 0
  private snt = 0
  private st = 0
  private samples = 0
  private priorSamples = 0
  private readonly ridge: number

  constructor(ridge = 1e-9) {
    this.ridge = ridge
    // Priors as three pseudo-prompts: one wide character ≈ 0.6 token, one narrow ≈ 0.2,
    // and no assumption about the constant. Real observations outweigh them quickly,
    // while a session with almost no data still produces sane numbers.
    const priorWeight = 1e-3
    this.add(1, 0, 0.6, priorWeight)
    this.add(0, 1, 0.2, priorWeight)
    this.add(0, 0, 1, priorWeight)
    this.priorSamples = 3 * priorWeight
  }

  /**
   * Record one prompt: its character classes and the size the provider billed.
   * @param wide - wide character count of everything sent.
   * @param narrow - narrow character count of everything sent.
   * @param tokens - billed prompt tokens.
   */
  observe(wide: number, narrow: number, tokens: number): void {
    this.add(wide, narrow, tokens, 1)
  }

  /**
   * Accumulate one weighted observation.
   * @param wide - wide character count.
   * @param narrow - narrow character count.
   * @param tokens - billed tokens.
   * @param weight - how much this observation counts (priors use a tiny weight).
   */
  private add(wide: number, narrow: number, tokens: number, weight: number): void {
    if (tokens <= 0 || wide + narrow === 0 || weight <= 0) return
    this.sww += weight * wide * wide
    this.swn += weight * wide * narrow
    this.sww2 += weight * wide
    this.snn += weight * narrow * narrow
    this.snn2 += weight * narrow
    this.st += weight * tokens
    this.swt += weight * wide * tokens
    this.snt += weight * narrow * tokens
    this.samples += weight
  }

  /**
   * Whether the observations can actually separate the two character classes.
   *
   * If every prompt grows with the same mix of CJK and Latin, the two features are
   * collinear and the regression will happily put all the weight on one of them — a
   * perfect fit with worthless coefficients (measured: narrow came out as 86 tokens per
   * character). Correlation between the two series is the test for that.
   * @returns `true` when the fit is meaningful.
   */
  identifiable(): boolean {
    if (this.observations < 3) return false
    const n = this.samples
    const sw = this.sww2
    const sn = this.snn2
    const numerator = n * this.swn - sw * sn
    const left = n * this.sww - sw * sw
    const right = n * this.snn - sn * sn
    if (left <= 0 || right <= 0) return false
    const correlation = Math.abs(numerator) / Math.sqrt(left * right)
    return correlation < 0.95
  }

  /**
   * Current coefficients.
   * @returns Tokens per wide/narrow character (content) and the constant prompt overhead.
   */
  coefficients(): { wide: number; narrow: number; overhead: number } {
    // Priors: CJK ≈ 0.6 tok/char, Latin ≈ 0.2 tok/char, overhead ignored until data says
    // otherwise. The ridge is large enough that a handful of same-shaped turns cannot
    // produce a wild split between text and overhead.
    const priorWide = 0.6
    const priorNarrow = 0.2
    const priorOverhead = 0
    // Too little signal to separate text from the constant: report the priors rather than
    // a solution the pseudo-observations alone would distort.
    if (this.observations < 2 || !this.identifiable()) {
      return { wide: priorWide, narrow: priorNarrow, overhead: priorOverhead }
    }
    const r = this.ridge
    // Normal equations for [a, b, c]:
    //   a·Σw² + b·Σwn + c·Σw = Σwt
    //   a·Σwn + b·Σn² + c·Σn = Σnt
    //   a·Σw  + b·Σn  + c·N  = Σt
    const m = [
      [this.sww + r, this.swn, this.sww2],
      [this.swn, this.snn + r, this.snn2],
      [this.sww2, this.snn2, this.samples + r],
    ]
    const rhs = [this.swt, this.snt, this.st]
    const solved = solve3(m, rhs)
    if (solved === undefined) return { wide: priorWide, narrow: priorNarrow, overhead: priorOverhead }
    const [wide, narrow, overhead] = solved
    return {
      wide: wide > 0 ? wide : priorWide,
      narrow: narrow > 0 ? narrow : priorNarrow,
      // A negative constant is meaningless; clamp at zero rather than "learning" nonsense.
      overhead: overhead > 0 ? overhead : 0,
    }
  }

  /**
   * Estimate the tokens of some text, excluding prompt overhead.
   * @param text - text to estimate.
   * @returns Estimated tokens.
   */
  estimate(text: string): number {
    if (text === '') return 0
    const { wide, narrow } = classCounts(text)
    const { wide: perWide, narrow: perNarrow } = this.coefficients()
    return Math.max(1, Math.round(wide * perWide + narrow * perNarrow))
  }

  /** How many real prompts the fit is based on (priors excluded). */
  get observations(): number {
    return Math.max(0, this.samples - this.priorSamples)
  }
}

/**
 * Gaussian elimination for a 3×3 system.
 * @param m - coefficient matrix.
 * @param rhs - right-hand side.
 * @returns The solution, or `undefined` when the system is singular.
 */
function solve3(m: number[][], rhs: number[]): [number, number, number] | undefined {
  const a = m.map((row, index) => [...row, rhs[index]])
  for (let column = 0; column < 3; column++) {
    let pivot = column
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row
    }
    if (Math.abs(a[pivot][column]) < 1e-9) return undefined
    ;[a[column], a[pivot]] = [a[pivot], a[column]]
    for (let row = 0; row < 3; row++) {
      if (row === column) continue
      const factor = a[row][column] / a[column][column]
      for (let k = column; k < 4; k++) a[row][k] -= factor * a[column][k]
    }
  }
  return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]]
}
