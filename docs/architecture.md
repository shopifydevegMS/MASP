# MASP v1: architecture (Phases 1 to 5)

## Components

| Brief item | Where | What it does |
|---|---|---|
| A. Session registry | `config.ts`, `engine.ts` (`registerSessions`) | Sessions are declared in `masp.config.json` (worktree, task, `owns`, `shared`). A session is registered only if its worktree belongs to the same repository and its HEAD is the preview's base commit. |
| B. File watcher | `controller.ts`, `scan.ts` | Recursive `fs.watch` on each worktree wakes the controller. A reconciliation pass (default every 30 s) catches missed events. A file counts as stable only when the same content hash has been seen for `settleMs`, so bursts of writes and temp-file-then-rename saves publish only the final version. Hashes are cached by size and modification time. |
| C. Ready signal | `commands.ts` (`ready`) | `masp ready --session A` snapshots the session's changed files into the store and queues a request. The controller re-reads every file and rejects the request if anything changed since the signal. A Ready change set is all-or-nothing. |
| D. Integration queue | `lock.ts`, `controller.ts` | One writer at a time through an exclusive lock file (`O_EXCL`). A second controller or `integrate` is refused. A lock left by a dead process is moved aside and taken over. Requests are processed first in, first out. |
| E. Snapshot store | `store.ts` | `.masp/` holds content-addressed blobs, `state.json` (replaced atomically), `journal.jsonl` (append-only, fsynced), one record per checkpoint, and processed requests. Nothing is deleted automatically. |
| F. Conflict detection | `plan.ts` | Three-way check per file (below), plus scope and ownership rules. |
| G. Shopify validator | `validate.ts`, `deps.ts`, `shopify-json.ts` | JSON syntax with Shopify's header comment, duplicate keys, template `sections`/`order` consistency, Liquid tag balance, `{% schema %}` JSON, and references (`render`, `include`, `section`, `sections`, `asset_url`, template section types). |
| H. Preview publisher | `publish.ts` | Staged, journalled publish with rollback and crash recovery (below). |

## Three-way check

For each file a session changed:

* **base**: what this session last integrated (initially the base commit version)
* **source**: the session's current file
* **preview**: what the unified preview holds now

| Situation | Result |
|---|---|
| source = base | no change from this session |
| preview = base | nobody else changed it: publish |
| preview = source | already identical: recorded as integrated |
| anything else | blocked (`stale` or `conflict`), nothing overwritten |

For templates and section groups, the "anything else" case first tries the structured merge below.

A blocked session can merge by hand: `masp show <path>` prints the preview version and its hash.
After merging, `masp ready --rebased <path>@<hash>` is accepted only if the preview still holds exactly that version.

Text files are compared and published with LF line endings, so `core.autocrlf=true` worktrees do not look changed.

## Shopify JSON merge (Phase 2, `jsonmerge.ts`)

Applies to `templates/**/*.json` and `sections/*.json` (section groups) when the session's version,
its base and the preview all parse. The session's change (base to source) is split into operations,
and each is applied to the **current preview** only if its precondition still holds:

| Operation | Allowed when |
|---|---|
| add section `id` | the preview has no section with that id (an identical one counts as already done) |
| modify section `id` (whole section) | the preview's section is still the base version |
| remove section `id` | the preview's section is still the base version |
| set or remove a top-level key (`layout`, `wrapper`, `name`...) | the preview's value is still the base value |
| insert ids into `order` | the base neighbours the new ids sit between are still adjacent in the preview |

Always blocked: two changes to the same section (even different settings), reordering existing sections,
an insertion point that was deleted or moved, a duplicate id, duplicate JSON keys, invalid JSON.
Two inserts at the same position (for example both appending at the end) are blocked by default;
`"jsonSamePosition": "after-existing"` places the later one after the earlier one.

The merged file is written from an order-preserving tree: the header comment, indentation, key order
(including numeric-looking ids) and every string and number token stay exactly as they were, so only the
changed parts differ. The result then goes through the same validation and dependency checks as any change.

After a merge, the session's base becomes **its own version**, not the merged file, so its next change is
again compared only with what it edited itself.

## Publishing and recovery

1. Check every target file in the preview still has the expected content. Refuse if something outside MASP changed it.
2. Journal `begin` with every file's old and new hash.
3. Stage new files in `.masp/staging/<txn>/`, on the same drive as the preview.
4. Rename each staged file over its target, retrying when Windows reports the file is in use. Deleted files are moved into staging, not unlinked.
5. If a rename fails, the files already replaced are restored and the journal records `rolledback`.
6. Save state, then journal `commit`.

**Each file is replaced atomically. A multi-file publish is not atomic.** If the process dies between two renames, the preview briefly holds a mix of old and new files.
On the next start (or `masp recover`), every interrupted transaction is checked file by file:

* state already saved: the transaction completed, so it is marked done;
* every file is either its old or its new version: new versions are rolled back. The source changes are still in the worktrees and are published again on the next pass;
* any file matches neither version (someone else wrote to the preview): nothing is touched. MASP stops publishing and reports the exact files. `masp recover --restore-preview` saves the outside versions into the store, then puts MASP's versions back.

Outside edits to the preview at any other time are handled the same way, because the preview is checked against MASP's records before every pass.

## Local preview and Theme Check (Phase 3)

* `masp verify` treats the preview as a complete theme: it needs `layout/theme.liquid`,
  `config/settings_schema.json` and a home page template. It warns when `settings_data.json` or a default
  locale is missing. On top of that it runs every local check and dependency check, and the comparison with MASP's records.
* `masp check` runs `shopify theme check --path <preview> --output json` offline. It never passes
  `--auto-correct` or `--init`, because both would write into the preview. The result is stored together with a fingerprint
  of the preview, so `status` reports it as current or OUTDATED. If the preview changed while the check ran, the result
  is marked unreliable. A missing or broken CLI is reported as "could not run", never as a pass.
  Theme Check runs only on demand. A full check takes about 14 s on 1,000 files, too slow for every change.
* `masp preview` is a preflight. It prints the single `shopify theme dev` command only when the preview matches
  MASP's records, nothing is waiting for recovery, and there are no completeness or validation errors. Otherwise it
  lists the problems and exits with code 8. It never starts the CLI or logs in.

Flags checked against Shopify CLI 4.9.4 (`shopify theme dev --help`): `--path`, `--store` and `--port` are used.
`--theme` is left out, so Shopify creates a separate development theme.
`--theme-editor-sync`, `--allow-live` and `--reconciliation-strategy` must never be used.

## Remote preview (Phase 4, run on 2026-10-29)

Setup: `shopify theme pull` (read-only) of an unpublished theme from a real store
(656 files) into `sandbox/<name>/pull`, then `examples/setup-real.ts` (new repo, one baseline commit made by the
setup script, worktrees a and b, `masp init`). One `shopify theme dev --path sandbox/<name>/preview --store <store>.myshopify.com --port 9292`,
without `--theme`. The live theme and the source theme were never written to.

Result (Test 10): agent A added a section at the end of the home page, and agent B added one at the start, starting from the old
template. Both Ready signals were published (B's by a structured merge) about 1.2 s after the first signal. The page
rendered by Shopify showed A's section after 3.5 s and B's after 5.4 s, in the expected order. The CLI log showed one
"Synced" line per uploaded file.

Findings from the real theme:
* **Shopify accepts trailing commas and `/* */` or `//` comments in theme JSON**, including `{% schema %}`, locales and
  `settings_schema.json`. Strict JSON parsing flagged 195 working files. The parser now accepts both. A template whose
  JSON contains comments is not merged automatically, because rewriting it would lose them.
* **Theme Check is noisy on real themes:** 3,250 errors, 3,231 of them `MatchingTranslations`, and a 36 s run.
  That is why it is advice (`masp check`), not a publish gate.
* **Shopify CLI reuses this computer's existing development theme** ("Development (<id>-<computer>)") instead of creating
  a new one, and replaces its contents. Do not run another `theme dev` for the same store from this computer while
  the MASP preview runs, or they will overwrite each other.
* The store already had 20 regular themes (Shopify's limit). Development themes do not count toward it.
* Theme blocks (`blocks/`) are used. Their references are not yet part of MASP's dependency checks.
* Shopify sync is still "unconfirmed" in `masp status`. Confirmation came from the CLI's own log and the rendered page.
  A later version could read the CLI log to report sync per file.

## Real AI sessions (Phase 5, run on 2026-10-29)

Two headless Claude Code sessions (`examples/run-agents.ts`, Claude Code 2.1.312) ran at the same time on the real
theme copy, with the controller running and permissions as in [providers.md](providers.md).

* **A:** announcement bar section plus its CSS, inserted after the slideshow. **B:** trust badges section plus its CSS, inserted before the FAQ.
* Both CSS files and both section files were published automatically. A's section was published only after its CSS
  existed. Both template changes were signalled with `masp ready` and merged. Each landed exactly where its task said.
* Each session took under a minute, about 12 turns and about $0.70.
* Checks afterwards: Git history unchanged (commits, refs, HEADs, reflogs). Each worktree changed only its own 3 files
  (A's template does not contain B's section, and the other way round). The preview matches MASP's records, with no
  conflicts. Theme Check finds no issues in the 4 new files.
* The fence held: no MCP servers were loaded. The only refused actions were each session's attempt to run an ad-hoc
  `node -e` / `python` command to validate its JSON. Both still reported honestly that this check had not run.

### Real conflict between AI sessions (run on 2026-10-29)

Both sessions were given tasks in the same `faq` section of the home page. A fixed the answer to question 2. B added a new
question 6. MASP never merges inside one section, so the second Ready had to conflict.

1. B ran `masp lint` (passed), then `masp ready`: published (18 s, $0.39).
2. A ran `masp lint`, which already reported the conflict with B. `masp ready` was rejected and nothing was overwritten.
3. A ran `masp show templates/index.json`, merged B's new question into its own file by hand, kept its own fix, and signalled
   with `--rebased templates/index.json@<version>`: published (56 s in total, $0.51).
4. Result: the preview's FAQ has both A's corrected answer and B's new question. Git history is unchanged, each worktree
   changed only its own template, there are no open conflicts, and the preview passes all checks.

Lesson: A tried `masp lint` after merging but without `--rebased`, so lint still showed the old conflict. The session
rules and the hint printed by `masp show` now say to pass the same `--rebased` to lint (covered by a test).

## Status levels

`masp status` keeps these separate:

| Level | Meaning |
|---|---|
| Local integration | Last committed transaction. |
| Local preview | Whether the preview folder matches MASP's records. |
| Theme Check | Last result, and whether it still describes the current preview. |
| Shopify sync | Always "unconfirmed". MASP cannot see what `shopify theme dev` uploaded. |
| Visual check | Always "not done" until a person looks. |

## Test coverage (Phase 1)

| Test | File | Covers |
|---|---|---|
| 1 | `t01-independent-css` | A and B CSS changes, both one-shot and through the running controller, with write bursts and an editor-style safe save |
| 2 | `t02-shared-json` | A and B insert sections into one template (different positions): both appear, unrelated sections and the header unchanged, later edits merge again; same-position inserts blocked by default and allowed with the opt-in; section groups; a merged change still needs its section file |
| 3 | `t03-same-setting` | Same setting, and different settings of one section: the second change is blocked; worktrees and preview are preserved; the conflict persists |
| 4 | `t04-stale-worker` | Stale change to the same section blocked; stale but compatible change merged; verified manual rebase; rebase refused if the preview moved again; worktree HEAD not based on the base commit; registration refused |
| 5 | `t05-crash-recovery` | Killed mid-publish (rollback); killed after state save (completed); outside edit during a crash (stop + report + restore); locked file (in-process rollback); duplicate controller; stale lock |
| 6 | `t06-files-and-deletions` | Untracked files, temp files ignored, rename = auto add + Ready delete, deleting a referenced file refused, out-of-scope changes refused, file changed after Ready |
| 7 | `t07-dependencies` | Section held until its snippet exists, then both published together; template referencing an unpublished section refused; broken Liquid held |
| 8, 9 | `t08-t09-git-and-isolation` | A full session (auto, Ready, conflict, deletion, crash, recovery, controller start and stop) leaves commits, refs, reflogs, stash, remotes, index files and every worktree file (content and modification time) unchanged |
| Phase 3 | `t10-local-preview` | Theme Check on the preview: clean fixture passes, preview untouched, staleness tracked, an unknown filter that MASP's own checks miss is caught with the right file and line; a missing CLI is reported; the preflight withholds the dev command after an outside edit; completeness rules |
| 10 | manual, `.tmp/remote/agents.ts` | Real theme copy, one `shopify theme dev` on a development theme: two agents' sections reach the page Shopify renders, merged and in order (see "Remote preview") |
| 5 (AI) | manual, `examples/run-agents.ts` | Two real Claude Code sessions at the same time on the real theme copy (see "Real AI sessions") |
| lint, blocks | `t11-lint-and-blocks` | `masp lint` gives the same verdict as `masp ready` and changes nothing (state, queue, checkpoints, preview), including after a `--rebased` merge; theme block references from `content_for`, schemas and template block instances (nested); deleting a used block refused |
| 5 (AI conflict) | manual, `examples/run-agents.ts` | Two real Claude Code sessions with overlapping tasks in one section: conflict detected, resolved by the session with `masp show` and `--rebased`, both changes kept |
| merge | `jsonmerge` | Every merge rule above, plus byte-exact output and refusal of invalid input |
| unit | `unit` | Parser, validators, dependency extraction, line endings, globs, Git allowlist |

## Measurements on a 1,000-file theme (`examples/perf.ts`, this machine)

Generated theme: 1,006 files, 9.3 MB (120 sections, 300 snippets, 200 CSS/JS files, 300 images, 40 templates, 40 locales).
Raw numbers are in `docs/perf-results.json`.

| Metric | Value |
|---|---|
| `masp init` (one-time) | 5.6 s |
| First full scan of one worktree | 2.4 s (later scans: 65 ms with the size and modification-time cache) |
| Integration pass with no changes, both sessions | 0.23 s |
| CSS edit to preview with the controller (`settleMs` 300) | 0.93 s median, 1.04 s max (n = 10) |
| `masp ready` (template insert) to published, including Node start-up | 0.49 s |
| `masp verify` (whole theme) | 2.0 s |
| Shopify Theme Check (whole theme) | 13.7 s |
| Idle controller (full pass every 30 s) | 0.67% of one CPU core, 68 MB memory |
| Peak memory during the run | 92 MB |
| Files re-read when the controller restarts | 0 (hash cache saved in `.masp/scan-cache.json`) |
| MASP data folder after the run | 8.5 MB |

Edit-to-preview time is about two settle periods plus about 0.3 s: a file must look the same in two checks
`settleMs` apart before it is published. Lower `settleMs` for speed, raise it for slower editors.
File events trigger a pass over only the session that changed. The whole preview is compared with MASP's records
when its folder reports changes, and on every full pass. Each publish still checks its own target files first.

The hash cache trusts a file's size and modification time. A same-size rewrite that keeps the exact
modification time would be missed until the file changes again. Content is always re-read before it is published.

## Measurements (demo, this machine, 17-file fixture, `settleMs` 300)

| Metric | Value |
|---|---|
| Processes | 1 controller; MASP starts no Shopify server |
| Edit to preview, automatic | about 0.8 s. This is mostly the deliberate settle time: a change must be seen twice, `settleMs` apart. |
| `masp ready` to preview | about 0.4 s, including Node start-up |
| Controller | 25 passes in 11.6 s: 0.5 s CPU in total, 63 MB peak memory, 56 file reads for hashing |
| Crash recovery | about 35 ms |

These numbers come from the tiny fixture. The 1,000-file measurements are above.

## Limitations

* **JSON merging is deliberately narrow.** Only templates and section groups are merged, at whole-section granularity. Blocks inside a section, `settings_data.json`, locale files and every non-JSON file are compared as whole files.
* **Multi-file publishes are not atomic** (see above). The journal makes every interruption detectable and recoverable.
* **Shopify sync is observed, not controlled:** MASP publishes locally; whether and when the CLI uploads is visible only in the CLI's terminal.
* **Dependency checks are static.** References built from variables (`render some_var`), app blocks, locale keys and settings in `settings_data.json` are not checked. Changing a section's local block names does not re-check the templates that use them. Passing local checks does not prove the storefront renders.
* **Instructions are not permissions.** MASP refuses out-of-scope publishes and detects preview edits, but cannot stop an agent writing anywhere on disk. Claude Code permission rules and an OpenCode deny rule (documented in a later phase) reduce this.
* **v1 requires every session to start from the preview's base commit.** A worktree switched or reset to an unrelated commit is blocked.
* **PID reuse:** a stale lock is detected by checking whether its process is still running. If Windows reuses that process ID for another program, MASP refuses to start until the lock file is removed by hand.
* **Retention:** snapshots, checkpoints and journal entries grow without limit. A `gc` command that keeps the last N checkpoints and every blob referenced by state is planned.
* **Shopify sync is never confirmed** by MASP itself.

## Self-check and theme blocks

* `masp lint --session <id>` is a dry run of `masp ready`. It runs the same scope rules, merge and validation on a
  throwaway copy of the state. It never publishes, queues or records anything; the only thing it adds is snapshots in the
  content store. Sessions are allowed to run it, so they no longer need their own validation scripts.
* Theme blocks are checked like snippets. `content_for 'block', type: 'x'` and schema entries `{"type": "x"}` without a
  `name` need `blocks/x.liquid`. Block instances in templates and section groups must be a local block of their section
  (a schema entry with a name) or an existing block file, including nested blocks. On the real theme this finds 1,106 block
  references across 190 of its 201 block files, with no false alarms. Deleting a used block is refused.

## Upload tracking, cleanup and a longer run (2026-10-29)

**`masp serve --store <dev store>`** runs the preview preflight first, then the single `shopify theme dev` with only safe flags.
It timestamps every CLI line into `.masp/shopify-dev.log` and records itself in `.masp/serve.json`. Ctrl+C or
`masp serve --stop` kills the whole process tree (`taskkill /T` on Windows; plain stops had left the Shopify process running twice).
`masp status` compares each publish with the CLI's `Synced » update|delete <path>` and `Failed to upload file "<path>"` messages.
Per file, the latest event after MASP's latest publish decides: confirmed, waiting, or **REJECTED by Shopify** with the reason.
Rejections are also listed under the session that owns the file, so an AI session sees them with `masp status`.

**`masp lint`** also runs a quick Theme Check (about 2 s) on every Liquid and JSON file the session changed since the base
commit, including files already auto-published. Only syntax and schema checks count (`LiquidSyntaxError`, `ValidSchema`, ...).
Missing-file checks are skipped, because each file is checked alone and MASP checks dependencies itself.

**`masp gc`** is manual and a dry run by default. With `--apply` (which needs the writer lock) it removes checkpoint records
older than the newest `--keep` (default 100), their processed requests, snapshots nothing kept refers to, and leftover staging and temp files.
Everything the state, open conflicts, pending requests, kept checkpoints and interrupted transactions refer to is kept.
The journal is never trimmed.

**Longer run:** three Claude Code sessions (A, B, and a new C), two rounds of tasks run in parallel, with the controller and `masp serve` against the
development theme for about 12 minutes. That made 6 session runs costing $2.20, with 0 open conflicts at the end.

* Round 1: A extended its section (auto-published). B added a 4th badge to its section in the home template. C created a newsletter
  section and placed it directly before B's section. B and C each found their template copy out of date, used `masp show`, merged by hand
  and signalled `--rebased`. Both were published correctly.
* Round 2: A and B each removed their old test section from the home page and deleted its file in one Ready (the merged removal
  plus the deletion, with the dependency check passing). C added its newsletter to the product page.
* Every publish was confirmed uploaded, including both deletions. The rendered home page showed the new content and no old test sections.
  Git history was unchanged, each worktree held only its own session's changes, and whole-theme Theme Check numbers were unchanged.
* Controller: 90 passes in 11 minutes, 1.5% of one CPU core, 82.5 MB memory (stable). The MASP data folder is 13 MB, of which `gc` could free 0.2 MB.

Findings:
* **Shopify rejected a file MASP had passed.** C's first newsletter version put a filter inside the `{% form %}` tag options.
  MASP published it locally, and Shopify refused the upload (`Liquid syntax error`). C rewrote the file seconds later, and that version
  uploaded. This led to the quick Theme Check in `masp lint` (which reports exactly this as `LiquidSyntaxError`, covered by a test)
  and to per-file rejection reporting.
* **Deletions make a pass slow on a real theme:** about 3 s on 660 files, versus 0.15 s for other changes, because every file is checked
  for references to the deleted file. Caching each file's references by content hash would fix this.
* **`--permission-mode acceptEdits` also allows simple file commands (like `rm`) inside the worktree**, even though they are
  not on the Bash allow list. A and B deleted their files with `rm`. That stays inside the session's own folder, but the Bash fence is
  wider than the allow list suggests.

## Next steps before adopting MASP in a real project

1. **A full working day** with 2–3 sessions (this run was 12 minutes), then `masp gc` on a long history.
2. **Try OpenCode** with the documented settings (still untested).
3. **First real project:** set MASP up on a fresh clone of a real repository (not the working copy), land once, review the commit, push.

## Landing reviewed work on main (`masp land`, `masp resync`)

The workflow is: sessions work, MASP builds the preview, the developer reviews it in the Shopify preview, then
**`masp land`** puts exactly what the preview shows onto `main` as **one commit**.

```
masp land                         # dry run: lists every file, which session(s) made it, blockers and notes
masp land --yes --message "..."   # commit it to main (local only; never pushes)
git push origin main              # the developer pushes when ready
masp resync --session A --yes     # move a finished session onto the new main (repeat per session)
```

How it works:
* The commit is built in a temporary Git index: the preview's files on top of the commit the preview was built from.
  Before the branch moves, MASP checks that the new commit contains exactly the preview. The branch is moved with a
  compare-and-swap (`update-ref new old`), so it fails if `main` changed in the meantime. If `main` is checked out in the repo folder,
  that checkout is fast-forwarded (`read-tree -m -u`), which refuses to overwrite local changes.
* The commit message lists every file and the session(s) that changed it.
* If the process dies after the branch moved, the next `masp land --yes` notices that commit and records it, and
  finishes updating the checkout.

`masp land` refuses (exit code 9) when:
* `main` has commits the preview was not built from, for example from Shopify's GitHub integration or a colleague. Landing could
  overwrite them. Bring them into a fresh MASP run first.
* the preview was changed outside MASP, a publish was interrupted, or the preview fails MASP's checks;
* Shopify rejected a published file, so the Shopify preview you reviewed did not show it (`--force` overrides only this);
* the `main` checkout has uncommitted changes.

It warns, but still lands, when uploads were not confirmed, upload tracking was off, Theme Check was not run on this exact preview, or
a session has unpublished or blocked changes. Those changes are not landed and stay with their session.

Sessions are not disrupted by a landing. Each session keeps comparing against the commit it started from until it runs
**`masp resync`**. Resync resets the session's worktree to the landed commit, but only when nothing would be lost: no unpublished
changes, no open conflicts, no published-but-not-landed changes from that session, no commits of its own on the session branch,
and no changed files outside the theme folders.

Git write access lives in `src/gitwrite.ts`. It has its own allowlist (`hash-object -w`, `read-tree`, `update-index`,
`write-tree`, `commit-tree`, `update-ref` with an expected old value, `reset --hard <commit>`), and only `src/land.ts` may import it, which a test checks.
The controller and every other command still use the read-only wrapper. MASP never pushes, fetches, merges or rebases.

Run on the real-theme sandbox (2026-10-29): 8 files from sessions A, B and C landed as one commit (398 insertions, 3 deletions) with a
clean `main` checkout. All three sessions then resynced onto it, and each worktree now contains everyone's work.

## Faster dependency checks

Each file's references are cached by content hash (Liquid references, plus the local block types of each section), in memory
and in `.masp/refs-cache.json`. Parsed templates are cached in memory. Results are always valid because they depend only on the content,
and a test confirms they follow content changes. On the real theme (662 files), the check that a deletion leaves nothing broken took
about 1,000 ms every time. It now takes about 5 ms when warm, and 91 ms as the first check in a new process (cache loaded from disk).
