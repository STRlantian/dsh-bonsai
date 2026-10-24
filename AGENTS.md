# Working on this repository

Instructions for agents and humans working in `dsh-token-tree` (published as `dsh-bonsai`).

## Publishing needs explicit permission

**Never publish to npm, and never push a release tag, without being asked to.** Publishing is
visible to everyone who has installed the plugin and cannot be taken back cleanly.

- `npm publish`, `scripts/release.ps1`, `git push` of a release tag: **only on an explicit
  instruction** in the current conversation, for that specific release.
- Do not infer permission from "looks good", "分析一下结果", or a previous release.
- Committing and verifying locally is fine; pushing a branch or publishing is not.

If a release fix is urgent (a broken README, a corrupt manifest), say what is wrong and ask.

## GitHub pushes

Push only when asked. The default rhythm here is: change, verify locally, report, wait.

## Verification before claiming something works

- `pnpm run build`, `pnpm run typecheck`, `pnpm test` (147 cases) must pass.
- Behaviour claims about the host (folding, tool restriction, attachment) need a measurement:
  replay a real session with `scripts/probe-session-report.mjs` or run the relevant `probe-*`
  script. Numbers in the README must come from `docs/experiment-context-cache.md`.
- Replaying a session: call `backfillFromSession` **once**, not per event, or the tree doubles.

## Layout notes

- `client/client.js` is the built artifact, hand-written in the module-factory format. Edit it
  directly; there is no build step for it. Check syntax with `node --check`.
- `src/plugin/service.ts` holds the session state machine. Any change to attachment scoring or
  folding thresholds must be replayed against the sessions in `docs/experiment-context-cache.md`.
- `scripts/release.ps1` must stay UTF-8 clean: PowerShell 5.1 reads with the system code page,
  which once shipped a mojibake description to npm. Reads are explicit UTF-8; keep it that way.
