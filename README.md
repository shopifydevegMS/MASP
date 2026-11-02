# MASP v1: Multi-Agent Shopify Protocol

A local controller that lets two (or three) AI coding sessions work on one Shopify theme
in separate Git worktrees, while their safe changes are combined into **one** preview folder
served by **one** `shopify theme dev`.

Status: **beta.** It's tested (automated tests plus real runs with three Claude Code sessions on a copy of a real theme), but not yet
used on a real project. Expect mistakes: report them, and every fix should come with a test that keeps it fixed (see `CLAUDE.md`).
Review the preview before every `masp land`, and keep pushing a manual step.

**New here? Start with [docs/GUIDE.md](docs/GUIDE.md)**: install, daily workflow, conflicts, landing on main, team setup,
and how the old worktree-and-merge commands map to MASP.

Requirements: Node 23.6+ (runs TypeScript directly; no build step, no npm packages), Git 2.38+.

## Install (once per computer)

```powershell
git clone https://github.com/shopifydevegMS/MASP.git C:\tools\masp
npm install -g C:\tools\masp      # gives you the 'masp' command
masp --help
```

* **Keep the cloned folder.** The `masp` command links to it, so it must stay where it is.
* **Update** with `git -C C:\tools\masp pull`. There's no need to install again.
* **Don't use `npm install -g github:shopifydevegMS/MASP`.** npm would copy MASP into `node_modules`, where Node can't run its
  TypeScript files. MASP detects this and prints these steps instead.

Then start a piece of work on a theme (see the guide):
```powershell
masp new E:\work\round1 --repo <your theme repo> --branch main --sessions A,B
```

## Try it (from the cloned folder)

```powershell
npm test                  # 71 automated tests, each in its own throwaway sandbox under .tmp\
npm run demo              # builds sandbox\demo and runs two simulated agents
node examples/perf.ts     # about 2 minutes on a generated 1,000-file theme
node examples/setup-real.ts --source <theme folder> --target <new folder>   # MASP around a copy of a real theme
node bin/masp.ts status --config sandbox\demo\masp.config.json
```

## How it works

```
worktrees\a ─┐                         ┌─ preview\  ← shopify theme dev --path preview
worktrees\b ─┼─> MASP controller ──────┤
             │   (one process, lock)    └─ .masp\    state, snapshots, journal, checkpoints
```

* Agents edit only their own worktree. MASP reads worktrees and never writes to them.
* MASP is the only writer to `preview\`. Every publish is journalled and can be rolled back.
* MASP never commits on its own. The developer reviews the Shopify preview, then runs `masp land` to put exactly that onto
  `main` as one commit. Pushing stays a manual step. The controller's Git access is read-only in code.

Files fall into three classes (configurable):

| Class | Default paths | When it is published |
|---|---|---|
| independent | everything else (e.g. `assets/dev1.css`, `sections/a-*.liquid`) | automatically, once stable, if the session owns it exclusively and its dependencies exist |
| shared | `templates/**/*.json`, `sections/*.json`, `locales/**`, `config/**` | only after `masp ready` |
| critical | `layout/**`, `config/settings_*.json`, listed shared snippets | only after `masp ready`, and only if exclusively owned |

Deletions always need `masp ready`.

Two sessions may change the same template or section group: MASP merges whole-section changes,
section insertions and top-level keys, and blocks anything ambiguous (see docs/architecture.md).

## Commands

```
masp new <folder> --repo <repo> [--branch main] [--sessions A,B]   a ready workspace in one step
masp agent --session A           how to start an AI session (rules, permissions, start script)
masp init [--base <commit>]      create preview\ and .masp\ from a commit
masp start | stop                run / stop the controller
masp status                      sessions, pending files, conflicts, sync levels
masp ready --session A [--files a,b] [--message "..."] [--no-wait] [--rebased path@hash]
masp show <path>                 current preview version of a file (to merge a stale change)
masp integrate                   one pass without a running controller
masp conflicts | diff [--patch] | verify
masp lint --session A [--rebased path@hash]   dry run of 'ready' + quick Theme Check on the session's files
masp check                       Shopify Theme Check on the preview (offline, read-only)
masp preview                     preflight, then print the one 'shopify theme dev' command
masp serve --store <dev store>   run that one dev server (safe flags only) and track uploads per file
masp serve --stop                stop it, including its whole process tree
masp land [--yes] [--message ..] after reviewing the preview: commit exactly what it shows onto main (never pushes)
masp resync --session A [--yes]  move a finished session's worktree onto the landed commit
masp gc [--keep N] [--apply]     clean up old checkpoints and unused snapshots (dry run by default)
masp recover [--restore-preview]
```

Use `node bin/masp.ts <command> --config <path>` (or set `MASP_CONFIG`, or run inside the folder
that holds `masp.config.json`). Add `--json` for machine-readable output.

## Layout

```
bin/masp.ts           CLI
src/                  controller (see docs/architecture.md)
test/                 harness + tests 1 to 9, merge and unit tests
fixture/theme/        small Shopify theme used by tests and the demo
examples/             demo and example configuration
sandbox/demo/         created by the demo
.tmp/                 throwaway test sandboxes
```

See [docs/architecture.md](docs/architecture.md) for the design, test coverage, measurements and limitations,
and [docs/providers.md](docs/providers.md) for running sessions with Claude Code or OpenCode.
