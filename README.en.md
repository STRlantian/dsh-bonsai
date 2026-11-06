# Bonsai / 盆栽

**A conversation-tree editor for DeepSeek Harness, plus two switches that really do save tokens.**

[简体中文](https://github.com/STRlantian/dsh-bonsai/blob/main/README.md) · English

A conversation is drawn as a tree: questions, answers and tool results are nodes you can fork,
re-parent, hide, recycle, and jump back to in order to keep growing from an earlier point. The tree
also carries exact token accounting, and two ways to keep what no longer belongs out of the model's
view.

```text
dsh-bonsai · DeepSeek Harness plugin · no runtime dependencies · MIT · Node ≥ 24
```

## Evidence first

Numbers come in two kinds, both recorded in
[`docs/experiment-context-cache.md`](docs/experiment-context-cache.md): **measured** (live A/B, log
replay, billing fields) and **modelled** (cost estimated from a stated price ratio). Each entry says
which one it is.

| Capability | Status | Measured |
|---|---|---|
| **Hide tools** | Optional (defaults to hiding `tree_mark` and `tree_focus`; `[]` shows all) | 37 → 28 tools: **10,453 → 7,076 tokens/turn (−32%)** |
| **Fold history** | On by default; the block must reach 30,000 tokens and 8x the keep window, at most every 10 turns | Live A/B: prompt/step **−9.2%**, but new input **+202%** (cache invalidated); short sessions cost **more**. The 60-turn cost model favours the tuned default |
| Effect of folding on the cache | — | Every fold rewrites the prefix, so the cache misses: this is its real cost (experiment 23) |
| Graphical tree editing / recycle bin | Done | Fork, re-parent, hide, restore, jump, compare branches; **cancelled turns leave the tree on their own** |
| Rule editor | Done | Hand-written and auto-detected rules as chips, add/edit/delete, sent with the retrieval hint |
| Exact token accounting | Done | Official tokenizer; falls back to the bill when no vocabulary is available |
| Retrieval gain (`retrieve_context`) | **Not proven** | Five experiments found no recall benefit; off by default |

## Install

Requires DeepSeek Harness (the desktop app or the `dsh` CLI). **Quit the desktop app completely**
before installing.

```powershell
dsh plugin --profile desktop add dsh-bonsai
```

After a restart a **🌳 Bonsai** panel sits above the composer, and a “Bonsai” button appears in the
session header.

Local development (no npm):

```powershell
pnpm install; pnpm run build; node scripts/stage.mjs
dsh plugin --profile desktop add "file:<repo>/plugin"
```

> Do not point a `link:` at the repository root — the desktop app treats that root as a workspace
> and scans it.

## The interface

- **Dock above the composer**: canvas on the left, details on the right; it never covers the
  conversation. Click a node to jump to that turn.
- **The “Bonsai” editor**: five tabs — blocks / full tree / graph / recycle bin / settings.
- **Drag one row onto another**: re-parents the whole subtree; **delete** is a soft hide, and the
  recycle bin restores it.
- **“Continue from here”**: your next question attaches under that node (one turn only).

## Diagnostic commands

Five slash commands, typed in the chat; the output is shown to you and never enters model history:

| Command | Shows |
|---|---|
| `/tree` | the conversation tree (`/tree go n12` anchors the next turn, `/tree clear` drops it) |
| `/prompt` | last prompt shape: characters per system section, how much is tool schemas, the messages the hook saw |
| `/fold` | last fold decision: how many turns, block size, threshold, and whether cadence or the ratio blocked it |
| `/usage` | last bill: new input / cache hit / cache write, plus the hit rate |
| `/retrieve` | last `retrieve_context`: query, budget, tokens used, selected and dropped nodes |

Each one answers with a line of explanation in an empty session instead of failing; the numbers come from billing fields and the plugin's own records, not estimates.

## The two token switches

### 1. Hide tools (optional, the most direct one)

83% of the prompt's characters are tool definitions. The “hide tools” panel in settings reads the
real tool list from the host; whatever you tick applies per agent:

```text
37 tools, 34,271 chars → 28 tools, 21,224 chars
prompt  10,453 → 7,076 tokens (−32%, saved every turn)
```

Nothing is hidden by default, because what you hide is **capability**. The list has to be right: the
host validates every tool name and rejects the whole set when one is unknown (the settings panel
shows the raw error).

### 2. Fold history (on by default)

> **Folding shrinks the prompt, not the bill.** Live A/B (same tools, same questions, ABBA twice each):
> prompt/step 10,345 -> 9,392 (-9.2%), but new input 3,674 -> 11,112 (+202%) - each fold rewrites the
> prompt prefix and drops the cache. At a cache-read price of 1/10 the input price, folding the same
> six-turn session was about 23% **more expensive**.
>
> Folding pays off in **long sessions**, where folds are rare relative to turns and the folded content
> is large. A 100-turn sweep (`docs/experiments/fold-param-sweep.md`) puts the balanced default at
> 30,000 / keep 2 / 8x / cadence 10; the old 40,000 / keep 3 / 5x / cadence 3 setting was too
> conservative and only broke even around turn 45.
>
> The price ratio is an **assumption**, not a constant: with `miss/hit = p`, one fold costs
> `(1-1/p) * keep window` and saves `(1/p) * block` per later turn, so the break-even is
> `N* = (p-1) * window / block`. At p=50 a block of 8x the window pays back in about 6 turns;
> cadence 10 then amortises the rewrite. Lower the ratio if your real price gap is smaller. Details
> in `docs/experiment-context-cache.md`, experiment 23, and the new sweep report.

Session history is derived by the host from the log. The plugin appends one
`surfaceOp: { op: 'replace', startSeq, endSeq }` event, and the covered range stops entering
`deriveMessages()` — **not a byte of the original log changes**, and the tree still holds the full
text.

```text
Daily default: fold when the block reaches 30,000 tokens and 8x the keep window, at most every 10 turns
Keep context: fold past 60,000, keep 4 turns
Save:         fold past 10,000, keep 1 turn, and hide 9 heavy rarely-used tools
```

Five intent-named presets sit at the top of the settings page; each button carries a one-line
explanation, and every value is still adjustable:

| Preset | When to pick it | What it does | Block floor | Turns kept | Fold scope | Tools hidden |
|---|---|---|---|---|---|---|
| **Tree only** | just the tree, no model-facing behaviour | turns off injection, hints, candidates, folding, reflection | 0 (off) | 0 | off | none |
| **Daily default** | when unsure | balances cost and context | 30,000 | 2 | whole turns | none |
| **Coding** | editing files, lots of tool output | folds tool results only, keeps whole-turn context | 20,000 | 3 | tool output | none |
| **Keep context** | quality first, do not drop recent turns | folds rarely, closest to native | 60,000 | 4 | whole turns | none |
| **Save** | cheapest, tight context window | folds earlier, keeps one turn, hides heavy tools; retrieve old detail on demand | 10,000 | 1 | whole turns (retrieval returns digests) | 9 heavy rarely-used tools |

| Setting | Default | Effect |
|---|---|---|
| `foldAboveTokens` | `30000` | The block about to be removed must reach this; `0` leaves only the relative rule |
| `foldBlockRatio` | `8` | The block must also be at least this many times the keep window; `0` disables it |
| `foldCadence` | `10` | Minimum turns between two folds (a fold rewrites the prefix cache) |
| `foldTrigger` | `block` | `block` decides by block size; `history` is the old whole-history rule |
| `foldKeepTurns` | `2` | Keep this many recent turns verbatim |
| `foldScope` | `turns` | `turns` folds whole turns, `tools` folds only tool output |
| `attachChoices` | `10` | How many candidate questions the model sees each turn (questions only); `0` turns it off |
| `attachPrompt` | `any` | `any`: dependency `[attach:nX]`, new topic `[attach:root]`, meta turn `[attach:here]`; `follow`: anaphora only |
| `attachGate` | `always` | `uncertain`: offer candidates only when the local placement was unsure; measured 0/259 firings in a coding session, 18/18 and 256/256 in two others |
| `attachSummary` | `false` | Ask the model for an aspect summary shown in the candidate list; no measured benefit, off by default |
| `mandatoryContext` | `true` | Force-injects the answer a turn hangs under plus its question; this is a wiring guarantee (~99%), not a scoring gain |
| `fileRegion` | `auto` | Retrieval returns the current text of files this session read (auto/digest/content/off) |

The placeholder left behind tells the model where the text went:

> `[folded] The previous turn was removed from the context to save tokens; the full text is kept in the conversation tree — call retrieve_context when you need the details.`

## Letting the model place the turn

Every turn the model sees up to ten candidates (their **questions** only, never the answer text) and may
name one at the end of its answer:

```text
[attach:nX]    depends on one candidate (including anaphora)
[attach:root]  a new topic, put it under the root
[attach:here]  a requirement or meta turn ("I will ask, you judge"), stay on the current line
```

The hint also says: **when the question asks about a sub-concept some answer mentioned, attach to that
answer**. That sentence makes "answered A mentioning B and C, now ask B / ask C" put both under A:
3/5 -> 5/5 on the same five probes; without it the two follow-ups chain B->C.

Only ids offered that turn are accepted: an invented node number is ignored, and the marker is
stripped from the text, so it never reaches the tree or the next prompt.

## How long content is served

Long answers are never summarised (a summary rewrites code and numbers), and are served by size:

```text
<= 800 tokens   the text as is
800-3000        verbatim excerpt: the head plus sentences matching the question
> 3000          one line saying what it is about, the line count, and a pointer to the tree
```

The long tier giving only a referent line is deliberate: code, numbers and exact wording must be read
from the tree with `retrieve_context`, and the hint says that an excerpt is not the original.

## How a turn flows

```text
user message
  |
  +- local: scoring + anaphora gate + new-topic gate -> default parent
  |
  +- injected at the first step: retrieval hint (only past the size gate) + up to 10 candidate
  |  questions, never their answer text
  |
  +- the model answers and may end with:
  |     [attach:nX]   this depends on one of the candidates
  |     [attach:root] this is a new topic, put it under the root
  |
  +- the plugin moves the question only to an id it offered this turn; otherwise the local default
     stands
```

**What the model actually sees**: the host's conversation history (full answer text) until folding or
compaction trims it; folding replaces everything outside the last two turns once the estimated
block passes `foldAboveTokens` (30,000 by default) and is at least `foldBlockRatio` (8x) times the
keep window, at most every `foldCadence` (10) turns; the ten candidate *questions*; and whatever it
pulls with `retrieve_context`. "Only the previous turn" is true in long, already-folded sessions,
not in short ones.

## Settings

Everything is editable at runtime and stored in `~/.dsh/token-tree/settings.json` (only keys you
changed); precedence is **settings file > profile config**.

| Key | Default | Effect |
|---|---|---|
| `autoInject` | `false` | Push the whole retrieval block into the context every turn (about +428 tokens/turn) |
| `retrievalHint` | `true` | Add one hint line only, about 57 tokens/turn |
| `hintAboveTokens` | `12000` | Send the hint only once the conversation reaches this size |
| `autoReflect` | `true` | At turn end, grade the failure, write a reflection, retry a better sibling branch |
| `admitRelevance` | `0.3` | Retrieval admission threshold; relaxes once when it comes back empty |
| `toolDeny` | `[tree_mark, tree_focus]` | Tool names to hide (the picker fills it); neither was called in 201 session logs |
| `foldAboveTokens` | `30000` | Block threshold; `0` leaves only the relative rule |
| `foldBlockRatio` | `8` | Block must be at least this many times the keep window |
| `foldCadence` | `10` | Minimum turns between folds |
| `foldKeepTurns` | `2` | Turns kept verbatim |
| `foldScope` | `turns` | Fold scope |
| `tokenizerVersion` | `auto` | `auto` / `3` / `4` / `off` (estimate + calibrate against the bill) |
| `locale` | `auto` | Interface language: `auto` / `zh` / `en` |

API: `GET /api/token-tree/settings` returns `{ effective, overrides, path, availableTools, fold, toolRestriction, lastAssembly, … }`;
`POST` on the same path writes `{ key: value }` (`null` clears an override);
`POST /api/token-tree/preset` writes a whole preset at once.

## How it works

```text
user/message ─┐
assistant/message ├─▶ TokenTreeService ─▶ MemoryTree (nodes / edge weights / current)
tool/result   ─┘
                          │
              Where does a new question attach?
              ├ a specific term (shared by few nodes), weighted by how central it is to that answer
              │   → the answer that introduced that term
              └ only generic words → a new branch under the root
```

- The tree is rebuilt entirely from `user/message`, `assistant/message` and `tool/result`; no
  private events are appended.
- Reasoning **counts towards tokens but is not stored**: the billed output tokens far exceed the body
  length, so storing only the body would skew every threshold.
- Folding writes a single `surfaceOp: replace`; the log stays append-only.

## Honest limits

- **Retrieval has not shown a gain.** Replaying 219 questions in production order: the parent answer appears in the result 23% of the time and ranks first 11%; in experiment 2 the injected and plain arms both scored 5/5. `mandatoryContext` reaches ~99% by force, not by ranking.
  “tree + retrieve_context” at a 20k context, so the default configuration does not inject.
- **Folding hides the folded text from the model.** In the experiment it answered honestly (“that
  is not in this conversation”) instead of making something up — but it does not always call
  `retrieve_context` either.
- **The opening turn is never folded**: the first surface node is the system prompt, which only a
  system message can rewrite.
- **Compaction ≠ data loss**: the tree keeps the full text; compaction only shortens the prompt.

### What these numbers cover

Every figure is reproducible with the scripts in this repository, but each has a scope. Quote the
condition together with the number:

| Claim | Sample | Condition |
|---|---|---|
| Tools -32% | one real assembly (37 -> 28 tools) | one machine, that profile's tool set |
| Fold: prompt -9.2%, new input +202% | ABBA, two runs each | six-turn session, one model |
| Block rule: 420 -> 44 folds, 68.7% of the cost | nine sessions replayed | cost model with a stated price ratio, not a bill |
| Live arms 14,891 -> 8,544 | eight turns per arm, one run each | single run, noisy |
| Placement 14/18 | eighteen hand labels (one session) | one labeller |
| Paraphrase 3/8, jump set 6/15 | eight / fifteen synthetic probes | same session, appended questions |
| No retrieval gain | 219 replayed questions | one session, production order |

**Not claimed**: no overall "X% cheaper" (folding costs more in short sessions) and no recall gain
for retrieval. Counter-examples and failed experiments are kept in `docs/experiment-context-cache.md`
(BM25, jieba, BGE, admission thresholds).

The cache price ratio is an **assumption**: it is parameterised as `p` with break-even given for both
p=10 and p=50, so the "block = 5x window" default can be re-derived under your own pricing.

## Development

```powershell
pnpm install
pnpm run build      # TypeScript → dist/ + lib/client.js
pnpm test           # 249 cases (223 backend + 26 browser)
pnpm run check      # typecheck + tests
```

Zero-cost checks (no model needed):

| Command | Effect |
|---|---|
| `node scripts/bench-retrieval.mjs` | Retrieval recall against token cost |
| `node scripts/probe-tree-of.mjs <session>` | Replay one session's tree offline |
| `node scripts/probe-attach.mjs <session>` | Attachment score for every decision |
| `node scripts/probe-fold-estimate.mjs <session>` | How much folding would save |
| `node scripts/sweep-fold-params.mjs 100` | Fold-parameter grid over short/medium/long sessions |
| `node scripts/experiment-default-vs-baseline.mjs 60 3500 default` | Per-turn default vs full-context cost |
| `node scripts/inspect-compaction.mjs` | Count compaction events |

Scripts that need a model in the loop are `scripts/ab-*.mjs` and `probe-*.mjs`; their results live in
`docs/experiments/`.

## Release

The version in the repository is **always a test version** (`x.y.z-test.N`); the release script turns
it into a stable one:

```powershell
powershell -File scripts/release.ps1 -DryRun   # rehearsal
powershell -File scripts/release.ps1           # publish and move on to the next test version
```

It validates, sets `x.y.z`, publishes `./plugin` with `--tag latest`, advances the repository to
`x.y.(z+1)-test.0`, then commits, tags and pushes. Any failure rolls back.

## Layout

| Path | Contents |
|---|---|
| `src/core/` | Pure algorithms: graph, edge weights, path cost, weighted retrieval, grading and backtracking |
| `src/plugin/` | The DSH wiring: `Config`, the session service, tools, event subscriptions, HTTP routes, fold planning |
| `client/client.js` | Browser half: dock, editor, graph view, recycle bin, rule bar, settings panel, preset picker |
| `tests/` | 249 cases, including client tests that mount real React under jsdom |
| `docs/experiment-context-cache.md` | Every measurement (51 sections) |

## License

MIT © 2026 STRlantian

