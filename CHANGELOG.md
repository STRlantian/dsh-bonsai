# Changelog

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
