# MASP: notes for Claude Code sessions working on this repository

MASP (Multi-Agent Shopify Protocol) is a local command-line tool: several AI coding sessions work on one Shopify theme in
separate Git worktrees, and MASP combines their safe changes into one preview served by one `shopify theme dev`.
User guide: `docs/GUIDE.md`. Design, test results and limits: `docs/architecture.md`.

This file is for working **on MASP's own code**. AI sessions working on a theme get their rules from
`docs/agent-instructions.md` instead (see "Docs to keep in sync").

## MASP is in beta: find mistakes, fix them, prevent them

Expect bugs. When you find a mistake anywhere (code, docs, a test, or behaviour you observe while using MASP):

1. **Point it out to the user plainly**: what is wrong, what it could have caused, and how you found it. Don't fix it silently.
2. **Fix the cause**, not just the symptom.
3. **Make MASP prevent it from happening again.** Add a regression test that fails without the fix. Where it fits, also add a
   runtime check, so MASP refuses or reports the bad case instead of continuing (for example: validate the input, check before writing).
4. **Update the docs** if the behaviour, a limit or a command changed.

When in doubt between "continue" and "refuse with a clear message", MASP should refuse. Safety beats speed.

## Run it

* Node.js 23.6+ runs the TypeScript directly. There is no build step and there are no npm dependencies. Only erasable TypeScript
  syntax is allowed (no `enum`, no parameter properties, no `namespace`), and imports use `.ts` extensions.
* `npm test`: all tests. One file: `node --test test/t14-land.test.ts`. One test: add `--test-name-pattern="..."`.
* CLI: `node bin/masp.ts <command>` (or `masp` once installed with `npm install -g <this folder>`).
* `npm run demo`: two simulated sessions on the small fixture theme (`sandbox/demo`, git-ignored).

## Layout

| Path | What |
|---|---|
| `bin/masp.ts` | command line: parsing, help, printing |
| `src/engine.ts` | one integration pass: Ready requests, automatic publishing, checkpoints |
| `src/plan.ts`, `src/jsonmerge.ts` | ownership and scope rules; three-way check; structured template merge |
| `src/publish.ts` | journalled publish into the preview, rollback, crash recovery |
| `src/controller.ts` | `masp start`: file watching, passes, the writer lock |
| `src/validate.ts`, `src/deps.ts`, `src/shopify-json.ts` | Liquid/JSON checks, references between files, lenient Shopify JSON parser |
| `src/land.ts`, `src/setup.ts`, `src/gitwrite.ts` | `masp land` / `resync` / `new`: the only Git write access |
| `src/serve.ts`, `src/themecheck.ts` | `masp serve` with upload tracking; Theme Check |
| `src/agents.ts` | per-session rules, permissions and start scripts |
| `test/harness.ts` | builds a throwaway repo, worktrees and preview under `.tmp/` for each test |
| `fixture/theme/` | small invented theme used by tests and the demo |

## Rules the code must keep

Tests enforce most of these. Don't weaken a test to make a change pass.

* **No automatic commits, ever. MASP never pushes, fetches, merges or rebases.** The controller and every normal command use
  the read-only Git wrapper in `src/git.ts`. Git writes exist only in `src/gitwrite.ts`, and only `src/land.ts` and `src/setup.ts`
  may import it (checked by `test/unit.test.ts`). Each write is something the developer runs explicitly.
* **Never write into a session's worktree** from integration code (Tests 8 and 9). `masp resync` is the one explicit exception,
  and it checks that nothing would be lost first.
* **Only `src/publish.ts` writes into the preview**, always journalled and verified, and never over a file that changed outside MASP.
* **Never overwrite or guess.** Conflicts are blocked and reported; content inside one section is never merged.
* **Never delete recovery data automatically.** `masp gc` is manual and a dry run by default.
* **Never contact a real store from tests.** Use `test/fake-shopify.mjs`. Tests that need the Shopify CLI skip when it's missing.
* **Never commit theme files or store logs.** `sandbox/` and `.tmp/` are git-ignored; keep it that way.
* Shopify accepts trailing commas and `/* */` or `//` comments in theme JSON. The parser must keep accepting them, and a merge
  must refuse files whose JSON contains comments (they would be lost).

## Lessons from building it (avoid repeating these)

* **Edit files with the editor tool, not shell heredocs, `sed` or `node -e`.** Backslashes in regexes and Windows paths were
  silently stripped several times: a broken `landBranch` check meant landing would have gone to `main` instead of the configured branch,
  and a `\r` became a real carriage return in the README. After any scripted edit, read the result back.
* **Windows:** stopping a shell does not stop the Shopify CLI it started. Kill the whole process tree (`taskkill /T /F`, see
  `killTree` in `src/serve.ts`). Replacing or deleting a file another process has open fails briefly, so use `withRetry` in `src/util.ts`.
* **Line endings:** worktrees use CRLF (`core.autocrlf=true`) while Git and the preview store LF. Always compare canonical content
  (`canonicalize` in `src/util.ts`), never raw bytes.
* **Caches must be keyed by content hash** (as in `src/deps.ts` and `src/scan.ts`) and must never create folders that no longer exist.
* Test with the real thing when possible. The validator passed a file Shopify then rejected, and only a real run showed it.
  Theme Check now covers that case in `masp lint`.

## Docs to keep in sync

| Change | Update |
|---|---|
| user-facing behaviour or a command | `docs/GUIDE.md`, the `HELP` text in `bin/masp.ts`, `README.md` |
| design, a limit, test coverage | `docs/architecture.md` |
| what AI sessions must do | `docs/agent-instructions.md` (a template: `{{SESSION}}`, `{{OWNS}}`, `{{SHARED}}`, `{{PREFIX}}` are filled in per session by `src/agents.ts`) |
| AI tool settings | `docs/providers.md` |
