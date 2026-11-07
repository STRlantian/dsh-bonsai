# Bonsai / 盆栽

[简体中文](https://github.com/STRlantian/dsh-bonsai/blob/main/README.md) · English

**A conversation-tree plugin for DeepSeek Harness that starts with the two things that actually cost money:
folding history and retrieving it on demand.**

A conversation becomes a tree: questions, answers, and tool results are nodes that can branch, be re-parented,
hidden, restored, or used as a new starting point. The tree carries exact token accounting; the model sees
folded history by default and calls `retrieve_context` only when it needs an old detail.

```text
dsh-bonsai · DeepSeek Harness plugin · zero runtime dependencies · MIT · Node >= 24
```

## Fold history

> **Folding saves prompt size, not necessarily money.** Real web A/B (same tools, same questions, 13 turns,
> 5/5 correct): default prompt **−15.4%**, aggressive **−36.3%**. At cache miss = 50x hit, default cost
> **−9.7%**, aggressive **−2.9%** — **default wins** because aggressive folds more often, and every fold
> re-prices the keep window at the miss price. Break-even is around **18.3x**.
>
> This is a **price-dependent** result, not "fold earlier and save more". With `miss/hit = ρ`, keep window
> `W`, and block `T`, one fold loses about `(ρ−1)·W` and earns it back from the removed block. The steady-state
> optimum is `T* = t·√(2K(ρ−1))` (`t` tokens per turn, `K` kept turns). The default `K=2, ratio=8` is close at
> ρ=50. Folding suits **long sessions**; in a short session, or when miss/hit is low, do not rush it.

The host derives history from the append-only log. The plugin appends one
`surfaceOp: { op: 'replace', startSeq, endSeq }` event; the covered range stops entering `deriveMessages()`
while **the original log is untouched** and the tree still holds the full text.

The default threshold is derived from DeepSeek's cache prices, `0.02` (hit) / `1` (miss), and keeps the last
two turns; folds are at least ten turns apart. The formula is:

```text
T* = avgTurnTokens * sqrt(2 * keepTurns * (miss/hit - 1))
```

The settings panel still has a manual mode: enter the block token floor directly, or `0` to disable folding.
Three presets:

| Preset | Behaviour | Folding | Model-facing effects | Hidden tools |
|---|---|---|---|---|
| **Default** | general starting point; cost/context balance | automatic threshold | injection/hints/candidates/summary/reflection | none |
| **Tree only** | record the full tree | off | all off; tools remain callable | none |
| **Off** | silent to the model | off | all off; plugin tools hidden | 6 plugin tools |

The placeholder tells the model where the text went:

> `[folded] The previous turn was removed from the context to save tokens; the full text is kept in the conversation tree — call retrieve_context when you need the details.`

## Retrieval: on demand

`retrieve_context` is two-stage: it first returns a node index (id, kind, question/summary, size) without full
text; the model picks a node, then calls again with `nodeId` to read the text or an excerpt. `tree_query` can
also inspect the tree and one node directly.

Long answers are never summarised (a summary rewrites code and numbers); they are served by size:

```text
<= 800 tokens   the text as is
800–3000        sentence selection: head + whole matching sentences (no rewrite)
> 3000          one-line "what it is" + line count + pointer to the tree
```

The pointer is deliberate: code, numbers, and exact wording must be read back from the tree, and the hint says
that an excerpt is not the original.

Retrieval uses a local 256-dimensional hash by default (zero dependencies, offline). Optional BGE:

```yaml
config:
  bge: true
  bgeModel: Xenova/bge-small-zh-v1.5
  bgeChunkChars: 300
```

It applies only to the explicit `retrieve_context` tool: nodes are split into 300-character chunks and scored
with per-chunk `meanAll` cosine; if BGE is unavailable or fails, that call falls back to hash. Attachment,
auto-injection, and edge costs keep their original path. BGE needs `@huggingface/transformers` and a model cache.

**Honest limit: retrieval has not shown a recall gain.** Replaying 219 questions in production order, the
parent answer entered the result **23%** of the time and ranked first **11%**; injected vs control answered
5/5 vs 5/5. `mandatoryContext` raises it to about 99%, but that is **forced injection**, not better ranking.

## Evidence first

Numbers come in two kinds and are recorded in `docs/experiment-context-cache.md`: **measured** (real A/B,
log replay, billed fields) and **modelled** (estimated from stated price ratios). Each row says which.

| Capability | Status | Measured |
|---|---|---|
| **Fold history** | on by default; automatic threshold from 0.02/1 cache prices | Real web A/B (13 turns): default prompt **−15.4%**, aggressive **−36.3%**; at miss=50x hit, default cost **−9.7%**, aggressive **−2.9%**. Every fold rewrites the prefix — that is its real cost |
| Fold vs prompt cache | — | Every fold invalidates the prefix cache (experiment 23) |
| Retrieval (`retrieve_context`) | available; no automatic injection by default | no recall gain in five experiments; the model calls it explicitly when it needs an old detail |
| **Hide tools** | optional; hides `tree_mark` / `tree_focus` by default; `[]` shows all | 37 -> 28 tools: **10,453 -> 7,076 tokens/turn (−32%)** |
| Editable tree / recycle bin | done | branch, re-parent, hide, restore, jump, compare; **cancelled turns leave the tree** |
| Exact token accounting | done | official tokenizer; billed fields when no vocabulary is available |

## Install

Requires DeepSeek Harness (desktop or `dsh` CLI). **Quit the desktop app completely** before installing.

```powershell
dsh plugin --profile desktop add dsh-bonsai
```

After restart: a **🌳 Bonsai** dock appears above the composer and a “Bonsai” button in the session header.

Local development (without npm):

```powershell
pnpm install; pnpm run build; node scripts/stage.mjs
dsh plugin --profile desktop add "file:<repo>/plugin"
```

> Do not use `link:` on the repository root — the desktop app scans that root as a workspace.

## Interface

- **Dock above the composer**: canvas on the left, details on the right; click a node to jump to its turn.
- **Bonsai editor**: five tabs — conversation blocks / full tree / graph / recycle bin / settings.
- **Drag a row onto another**: re-parent it; the whole subtree follows. **Delete** is a soft hide; restore it
  from the recycle bin.
- **“Continue from here”**: your next question attaches under that node (one turn only).

## Letting the model place the turn

Every turn the model sees up to ten candidates (their **questions** only, never the answer text), and places
the turn before answering with:

```text
tree_attach(target="nX", summary="aspect 1, aspect 2")
```

`target` values:

```text
"nX"    depend on one candidate (including anaphora)
"root"  a new topic, put it under the root
"here"  a requirement or meta turn ("I will ask, you judge"), stay on the current line
"auto"  keep the automatic placement (use when only submitting a summary)
```

The hint also says: **when the question asks about a sub-concept some answer mentioned, attach to that
answer**. That sentence makes “answered A mentioning B and C, now ask B / ask C” put both under A:
3/5 -> 5/5 on the same five probes; without it the two follow-ups chain B->C.

Only ids offered that turn are accepted: an invented node number is ignored. Placement and summary are tool
arguments, never text markers, so they do not leak into the transcript.

## Settings

All settings are live and stored in `~/.dsh/token-tree/settings.json` (only keys you changed). Precedence:
**settings file > profile config**. There are two scopes: **global** (all sessions) and **this session**
(overrides only the current session; clearing a key falls back to global).

### Folding and cache prices

| Key | Default | Effect |
|---|---|---|
| `autoFold` | `true` | derive the threshold from cache prices; off uses the manual floor |
| `cacheHitPrice` | `0.02` | relative cache-hit price; automatic thresholding starts when both prices are positive |
| `cacheMissPrice` | `1` | relative cache-miss price; must exceed the hit price |
| `foldAboveTokens` | `30000` | manual block floor; the automatic threshold wins when enabled, this is the fallback |
| `foldBlockRatio` | `8` | block must also be at least this many keep windows; `0` disables the relative rule |
| `foldCadence` | `10` | minimum turns between folds (a fold rewrites the prefix cache) |
| `foldTrigger` | `block` | `block` measures the block; `history` is the older behaviour |
| `foldKeepTurns` | `2` | recent turns kept verbatim (the “window” in the formula) |
| `foldScope` | `turns` | `turns` folds whole turns; `tools` folds only tool output |

In the advanced settings area, **fold threshold** is one dropdown plus inputs:

- `Auto`: enter hit/miss prices; the threshold uses the measured average turn size.
- `Manual`: enter the block token floor directly.

### Retrieval and placement

| Key | Default | Effect |
|---|---|---|
| `autoInject` | `false` | inject the whole retrieval result every turn (about +428 tokens/turn) |
| `retrievalHint` | `true` | append a one-line hint (about 57 tokens/turn) |
| `hintAboveTokens` | `30000` | send the hint after the first fold; the value is diagnostic only |
| `admitRelevance` | `0.3` | retrieval admission threshold; relaxes once when empty |
| `mandatoryContext` | `true` | force the parent answer plus its question into the result; a wiring guarantee (~99%), not ranking |
| `fileRegion` | `auto` | retrieval returns the current text of files this session read (auto/digest/content/off) |
| `attachChoices` | `10` | candidate questions per turn (questions only); `0` disables |
| `attachPrompt` | `any` | `any`: dependency `target="nX"`, new topic `"root"`, meta `"here"`; `follow`: anaphora only |
| `attachGate` | `always` | `uncertain`: offer candidates only when the local placement was unsure |
| `attachSummary` | `true` | ask for an aspect summary in `tree_attach`; fall back to the 200-char heuristic |

### Other

| Key | Default | Effect |
|---|---|---|
| `autoReflect` | `true` | evaluate failed turns, write a reflection, backtrack to a better sibling |
| `toolDeny` | `[tree_mark, tree_focus]` | tools to hide (the checklist panel writes this) |
| `tokenizerVersion` | `auto` | `auto` / `3` / `4` / `off` (estimate + billed calibration) |
| `locale` | `auto` | UI language: `auto` / `zh` / `en` |

**Hiding tools** is an optional token saver: 83% of the prompt characters are tool definitions. The checklist
applies per agent. By default only `tree_mark` and `tree_focus` are hidden — never called in 201 real sessions,
yet about 570 tokens per request. Choose “show all” to write `toolDeny: []`. Names must be exact: the host
rejects the whole batch when one is unknown.

API: `GET /api/token-tree/settings` returns `{ effective, overrides, path, availableTools, fold, toolRestriction, lastAssembly, … }`;
`POST` the same path with `{ key: value }` (`null` clears an override); `POST /api/token-tree/preset` writes a whole preset bundle.

## Diagnostic commands

Five slash commands, sent in the session; results are shown to you and never enter model history:

| Command | What it shows |
|---|---|
| `/tree` | the tree (`/tree go n12` anchors the next turn at n12; `/tree clear` clears it) |
| `/prompt` | last prompt composition: system-prompt sections, tool share, message shape |
| `/fold` | last fold decision: turns folded, block size, threshold, cadence/ratio rejection |
| `/usage` | last billing: new input / cache read / cache write and hit rate |
| `/retrieve` | last `retrieve_context`: query, budget, tokens used, selected and dropped nodes |

An empty session answers with a line instead of throwing. Billing fields (`/usage`) are from the bill;
the plugin's own token count is exact when a tokenizer file is loaded, otherwise estimated/calibrated.

## How a turn flows

```text
user question
  |
  +- local: scoring + anaphora gate + new-topic gate -> default parent
  |
  +- injection (first step): retrieval hint (when large enough) + candidate questions (<=10, questions only)
  |
  +- before answering, the model calls tree_attach:
  |     target="nX"   depend on a candidate
  |     target="root" this is a new topic
  |     target="auto" keep the automatic placement
  |
  +- plugin: move the question only to an id it offered this turn; otherwise the local default stands
```

**What the model actually sees**

- the host's conversation history (full answer text) until folding/compaction trims it;
- folding: turns outside the last two, once the block passes the automatic threshold and is at least
  `foldBlockRatio` keep windows, at most every `foldCadence` turns;
- the ten candidate **questions**, never answer text;
- old detail on demand: `retrieve_context` for an index, then `nodeId` or `tree_query` for the text.

So “only the previous turn is visible” is true in long, already-folded sessions, not in short ones.

- The tree is replayed entirely from `user/message`, `assistant/message`, and `tool/result`; no custom events.
- Reasoning is **paid for but not stored** (billed output tokens exceed the visible text; storing only text
  would distort every threshold).
- A fold writes one `surfaceOp: replace`; the log stays append-only.

## Honest limits

- **Retrieval has not shown a recall gain.** In 219 replayed questions the parent answer entered the result
  **23%** of the time and ranked first **11%**; `mandatoryContext` raises it to about 99% by **forcing** it,
  not by ranking better.
- **Folding hides content from the model.** In tests it answered “that is not in the session” rather than
  inventing — but it also does not always call `retrieve_context`.
- **The opening turn is never folded**: the first surface node is the system prompt and can only be rewritten
  by a system message.
- **Compaction is not data loss**: the tree keeps the full text; only the prompt is shortened.

## Evidence boundaries

Every number can be reproduced with the scripts in the repo, but each has a scope. Quote the conditions too:

| Claim | Sample | Conditions |
|---|---|---|
| tool trimming −32% | one real assembly (37 -> 28 tools) | one machine, that profile's tool set |
| fold prompt: default −15.4%, aggressive −36.3% | one run per arm, 13 turns | web host, 5/5 correct, zero tool calls |
| fold cost: default −9.7%, aggressive −2.9% | same | **assumed** cache miss=50x hit; not a bill |
| attachment hit 14/18 | 18 hand labels (one session) | single labeller |
| paraphrase 3/8, jump set 6/15 | 8 / 15 synthetic probes | same session, appended questions |
| retrieval no gain | 219 replayed questions | one session (37bfb65c), production order |

**What is not claimed**: no “always cheaper”; folding can cost more in short sessions or at low miss/hit.
Counterexamples and failed experiments remain in `docs/experiment-context-cache.md`: BM25, jieba,
BGE vectors, retrieval admission.

The cache price ratio is an **assumption**, not a constant: the default `K=2, ratio=8` is near optimal at
ρ=50 (`T*/W = sqrt(2(ρ−1)/K)=7`). Recompute with the automatic threshold when prices differ.

## Development

```powershell
pnpm install
pnpm run build      # TypeScript -> dist/ + lib/client.js
pnpm test           # 251 tests
pnpm run check      # typecheck + tests
```

Zero-cost self-checks (no model needed):

| Command | Purpose |
|---|---|
| `node scripts/bench-retrieval.mjs` | retrieval recall vs token cost |
| `node scripts/probe-tree-of.mjs <session>` | replay a session's tree offline |
| `node scripts/probe-attach.mjs <session>` | attachment scores for every decision |
| `node scripts/probe-fold-estimate.mjs <session>` | how much folding can save |
| `node scripts/sweep-fold-params.mjs 100` | fold parameter grid (short/medium/long sessions) |
| `node scripts/experiment-default-vs-baseline.mjs 60 3500 default` | per-turn cost, default vs full context |
| `node scripts/inspect-compaction.mjs` | compaction-event statistics |

Model-in-the-loop experiments live in `scripts/ab-*.mjs` and `probe-*.mjs`; results are in `docs/experiments/`.

## Release

The repository version is always a test version (`x.y.z-test.N`); the release script turns it into a stable one:

```powershell
powershell -File scripts/release.ps1 -DryRun   # rehearsal
powershell -File scripts/release.ps1           # publish and move to the next test version
```

It verifies, writes `x.y.z`, runs `npm publish --tag latest`, moves to `x.y.(z+1)-test.0`, commits, tags, and
pushes. A failure rolls back automatically.

## Layout

| Path | Contents |
|---|---|
| `src/core/` | pure algorithms: graph, edge weights, path costs, weighted retrieval, reflection |
| `src/plugin/` | DSH wiring: `Config`, session service, tools, event hooks, HTTP routes, fold planner |
| `client/client.js` | browser side: dock, editor, graph view, recycle bin, rules bar, settings, presets |
| `tests/` | 251 tests, including jsdom-mounted React client tests |
| `docs/experiment-context-cache.md` | all measurements (53 sections, including failed experiments) |

## License

MIT © 2026 STRlantian
