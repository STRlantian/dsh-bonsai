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

Every number below is measured, not estimated. The raw records live in
[`docs/experiment-context-cache.md`](docs/experiment-context-cache.md).

| Capability | Status | Measured |
|---|---|---|
| **Hide tools** | Optional (nothing hidden by default) | 37 → 28 tools: **10,453 → 7,076 tokens/turn (−32%)** |
| **Fold history** | On by default, from 40,000 tokens | Controlled 4 turns: **15,341 → 12,906 tokens (−16%)**, zero model calls |
| Effect of folding on the cache | — | Hit rate **98.2%** (98.5% unfolded): no collapse |
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

Session history is derived by the host from the log. The plugin appends one
`surfaceOp: { op: 'replace', startSeq, endSeq }` event, and the covered range stops entering
`deriveMessages()` — **not a byte of the original log changes**, and the tree still holds the full
text.

```text
Default: fold past 40,000 tokens, keep the latest 3 turns, fold whole turns
Keep:    fold past 60,000, keep 4 turns
Save:    fold past 20,000, keep 2 turns, and hide 9 heavy rarely-used tools
```

Three presets sit at the top of the settings page, and every value is adjustable:

| Preset | Fold above | Turns kept | Tools hidden |
|---|---|---|---|
| **Keep** | 60,000 | 4 | none (closest to native behaviour) |
| **Balanced** (default) | 40,000 | 3 | none |
| **Save** | 20,000 | 2 | 9 heavy rarely-used tools |

| Setting | Default | Effect |
|---|---|---|
| `foldAboveTokens` | `40000` | Fold past this; `0` turns it off |
| `foldKeepTurns` | `3` | Keep this many recent turns verbatim |
| `foldScope` | `turns` | `turns` folds whole turns, `tools` folds only tool output |

The placeholder left behind tells the model where the text went:

> `[folded] The previous turn was removed from the context to save tokens; the full text is kept in the conversation tree — call retrieve_context when you need the details.`

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
| `toolDeny` | `[]` | Tool names to hide (filled by the checklist) |
| `foldAboveTokens` | `40000` | Fold threshold, `0` = off |
| `foldKeepTurns` | `3` | Turns kept verbatim |
| `foldScope` | `turns` | Fold scope |
| `autoCompactAboveTokens` | `0` | Automatic compaction; costs one model call over the whole history |
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
              ├ a specific term (shared by ≤1/3 of nodes) + semantic similarity
              │   → the answer that introduced that term
              └ only generic words → a new branch under the root
```

- The tree is rebuilt entirely from `user/message`, `assistant/message` and `tool/result`; no
  private events are appended.
- Reasoning **counts towards tokens but is not stored** (one answer measured 9,454 output tokens
  against 369 characters of body text; storing only the body would skew every threshold).
- Folding writes a single `surfaceOp: replace`; the log stays append-only.

## Honest limits

- **The retrieval gain is not proven.** Several experiments found no recall benefit from
  “tree + retrieve_context” at a 20k context, so the default configuration does not inject.
- **Folding hides the folded text from the model.** In the experiment it answered honestly (“that
  is not in this conversation”) instead of making something up — but it does not always call
  `retrieve_context` either.
- **The opening turn is never folded**: the first surface node is the system prompt, which only a
  system message can rewrite.
- **Compaction ≠ data loss**: the tree keeps the full text; compaction only shortens the prompt.

## Development

```powershell
pnpm install
pnpm run build      # TypeScript → dist/ + lib/client.js
pnpm test           # 164 cases (140 backend + 24 browser)
pnpm run check      # typecheck + tests
```

Zero-cost checks (no model needed):

| Command | Effect |
|---|---|
| `node scripts/bench-retrieval.mjs` | Retrieval recall against token cost |
| `node scripts/probe-tree-of.mjs <session>` | Replay one session's tree offline |
| `node scripts/probe-attach.mjs <session>` | Attachment score for every decision |
| `node scripts/probe-fold-estimate.mjs <session>` | How much folding would save |
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
| `tests/` | 164 cases, including client tests that mount real React under jsdom |
| `docs/experiment-context-cache.md` | Every measurement (1–15) |

## License

MIT © 2026 STRlantian
