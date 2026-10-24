# Changelog

## [0.1.7] — 2026-10-24

### Changed

- The three presets are named after what they do to the context: 保留最多 (fold only past 60k,
  keep 4 turns), 平衡 (40k, 3 turns, the default) and 省最多 (20k, 2 turns, and nine heavy tools
  hidden). The old 保守 / 均衡 / 激进 said nothing about the tradeoff.

### Fixed

- The tool picker listed only what the host still reports, so after applying 省最多 it showed 28
  tools with nothing checked while the row said "9 hidden". It now shows the union of the reported
  tools and the hidden names, with a "hidden" marker for the latter.

## [0.1.6] — 2026-10-24

Rules are editable, and the repository states its publishing rule.

### Added

- **Rule editor**: a bar above the editor lists every rule as a chip (auto-detected ones plain,
  hand-written ones marked), with add, edit and delete. Rules carry an id and a source, are
  recorded in the same append-only edit log as tree edits, survive a restart, and ride along with
  the retrieval hint so the model actually sees them.
- `AGENTS.md`: publishing to npm or pushing a release tag requires an explicit instruction.

### Fixed

- `POST /api/token-tree/edit` handles `action: rule` before it demands a `nodeId`, so a rule
  edit no longer fails with "nodeId is required".

## [0.1.5] — 2026-10-24

Branching fixes found by running the published build on a real 17-turn session, plus the
cache measurements from that run.

### Fixed

- Bigrams made only of function characters ("中的", "的对") are no longer features. They were
  supplying the "rarest shared term" that attached an algorithm question to a chord answer.
- The specificity gate is a tenth of the topic-owning nodes (floor 2) instead of a third, so a
  domain word like 算法 that appears in eight nodes no longer counts as this node's topic.
- A jump to another branch now needs two specific shared terms, or one of at least three
  characters; a lone short match is discounted to 0.3. Extending the current thread is exempt,
  because a genuine follow-up often shares a single term.

### Measured

- Folding capped that session at ~47k tokens where it would otherwise have grown past 90k, and
  every fold after the first kept a 98.5-99.7% cache hit rate.
- The first fold lands early (turn 2) and costs one round at 57.2% because it invalidates the
  tail; it is a one-time cost that pays back within a few turns.

## [0.1.3] — 2026-10-24

Documentation only: the README now leads with the measurements and states the limits plainly,
and the npm description lost a mojibake prefix.

### Changed

- README rewritten around what is proven: tool trimming (-32% per turn), history folding (-16%
  in a controlled run, cache hit rate unchanged at 98.2%), and an explicit list of what is not
  proven (retrieval gains) and what folding costs (the model stops seeing folded content and
  does not always reach for retrieve_context).
- package.json description and keywords rewritten; the old one carried a corrupted string.

## [0.1.2] — 2026-10-24

The first changes that actually move the token bill: tool schemas dominate the prompt, and
history can now leave the model's view without a model call.

### Added

- **Tool trimming** (`toolDeny`) — pick tools from a checklist built from the host's last
  assembly, not from memory: the settings row opens a modal with a search field, the schema
  size of every tool, and the tokens the current selection saves. Hides them per agent through
  the host's own `ctx.tools.restrict()`. Measured: 37 tools → 28 and 10,453 → 7,076 prompt tokens, **−3,377
  tokens on every turn**. Off by default; the settings panel shows the host's rejection reason
  (it validates names, and one unknown name rejects the whole filter).
- **History folding** (`foldAboveTokens`, `foldKeepTurns`, `foldScope`) — appends a
  `surfaceOp: { op: 'replace' }` event so old tool output (or whole turns) stops entering
  `deriveMessages()`. The log stays append-only and the original stays in the tree.
  Measured: −14.3% prompt with tool-result folding, **no model call**, and after a whole turn
  was folded the model called `retrieve_context` and answered correctly.
- **Presets** — 保守 / 均衡 / 激进, applied through `POST /api/token-tree/preset` in a single
  write so a fold threshold and its scope can never be seen half-applied. 激进 also hides the
  nine heaviest rarely-needed tools.
- **Recycle bin tab** — every hidden branch root, with preview, subtree size, token count, a
  restore button per row and "restore all".
- Read-only assembly diagnostics (`lastAssembly`, `lastDecision`, `fold`,
  `toolRestriction`) exposed on the settings route.

### Changed

- Attachment now refuses generic evidence: a shared term counts only when it appears in at most a
  third of the nodes that can own a topic. Measured on two real sessions, a cooking question and
  two unrelated questions stopped hanging under algorithm answers (0.319 → 0.044), while genuine
  follow-ups kept their place.
- Reasoning blocks count towards a node's tokens without being stored: one answer measured 9,454
  output tokens against 369 characters of visible text, so totals had been badly low.
- Folding measures the whole history instead of the current branch: on a real session the path
  read 9,431 tokens while the history held 97,208, which is why a 40,000 threshold never fired.
- The detail panel shows "of which reasoning" for answers that carried one.

- Folding defaults to **whole turns, above 40,000 tokens, keeping the last 3 turns**: long
  sessions stop re-sending history, short ones are untouched. Set `foldAboveTokens: 0` to
  disable.
- The opening turn is never folded: its first surface node is the system prompt, which only a
  `system/message` may rewrite.


All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [0.1.0] — 2026-10-22

First public release: the tree editing and token accounting that are actually used,
with retrieval shipped off by default.

### Added

- **Conversation tree as a plugin** — questions, answers, tool results and reflections are
  nodes; parent/child edges carry a non-negative cost. The tree is rebuilt from the durable
  session log, so it survives reloads without new event types.
- **Embedded panel above the composer** — graph and list views with a side action rail:
  move a branch to another parent, hide a subtree, jump to a node's turn in the transcript.
- **Standalone editor** with five tabs: blocks, full tree, graph, **branch compare**, settings.
- **Branch list in the detail panel** — selecting a node with two or more branches lists each
  branch's question, answer, edge cost and child count, with a "continue here" button per row.
- **Precise token accounting** — official HuggingFace `tokenizer.json` support with a
  from-scratch BPE reader; nodes are counted at creation, and the whole tree is recounted
  when a tokenizer loads.
- **Tokenizer selection by model generation** — `auto`, a generation (`3`, `4`), an installed
  directory name, or `off`; any `<name>/tokenizer.json` placed in the tokenizer directory is
  discovered, so non-DeepSeek models can be supported without code changes.
- **Budget safety** — the token budget is discounted (`conservativeBudgetRatio`, default
  `0.85`) while counts are estimates, and discounted further while drift is detected.
- **Drift monitor** — compares billed prompt growth against counted growth; warns once the
  ratio leaves `[0.85, 1.2]` and tries another installed tokenizer before giving up.
- **Billing-calibrated estimator** for models with no vocabulary file, guarded by an
  identifiability check (three coefficients cannot be separated from collinear prompts).
- **Runtime settings** (no restart): injection mode, hint thresholds, reflection, admission
  threshold, summary matching, tokenizer choice. Stored in `~/.dsh/token-tree/settings.json`.
- **UI language** — selectable in Settings (`auto` / `zh` / `en`), stored with the other overrides;
  `auto` follows the browser language. The host's `<html lang>` is a static template value and is
  deliberately not used. 95+ phrases; unknown phrases fall back to the Chinese source.
- **Theme awareness** — UI resolves the host's design tokens and follows light/dark, with
  `color-scheme` set so native controls match.
- **Tests**: 101 backend cases (graph, retrieval, reflection, persistence, routes, tokenizer,
  settings, billing) plus 5 browser-side cases that mount the real client code in jsdom.

### Known limitations

- **Retrieval gain is unproven.** Five experiments at the scale this harness compacts at
  (≈8k–25k tokens) showed no recall difference against no plugin, and the compaction summary
  preserved every exact detail that was probed. Consequently `autoInject` defaults to `false`
  and the hint only appears above 12,000 measured conversation tokens. The evidence, including
  the negative results, is in [`docs/experiment-context-cache.md`](docs/experiment-context-cache.md).
- The hint being emitted does not mean retrieval happens: in the compaction experiment the hint
  fired 13 times and the model called the retrieval tool zero times.
- Plugin id (`token-tree`), API routes (`/api/token-tree/*`) and the storage directory
  (`~/.dsh/token-tree`) keep the old internal name on purpose, so existing trees and edit logs
  keep working; only the published package and UI carry the Bonsai name.
