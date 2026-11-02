# MASP guide: from worktrees-and-merges to one combined preview

This guide is for developers who already work on Shopify themes with **Git worktrees and manual merges**, and who want to
run several AI coding sessions (Claude Code, OpenCode) on one theme at the same time.

MASP keeps what you already trust (each session in its own Git worktree) and removes the painful part: running one preview per
worktree, and merging by hand before you can see everything together.

---

## 1. What changes

| | The old way | With MASP |
|---|---|---|
| Isolation | one Git worktree per session | **same**: one Git worktree per session |
| Editors | one IDE window per worktree | one IDE window, one terminal per session |
| Shopify previews | one `shopify theme dev` per worktree, one preview each | **one** `shopify theme dev`, **one** preview with every session's work |
| Seeing work together | only after you merge branches | continuously: finished changes appear in the combined preview |
| Merging | you merge branches by hand, often | MASP combines safe changes; real conflicts are blocked and shown, never guessed |
| Commits | each session commits on its branch | sessions don't commit; **you** land the reviewed preview as one commit |
| Getting to `main` | merge every session branch | `masp land` puts exactly what you reviewed onto your branch |

What stays the same: Git is still the source of truth, your history is normal, and pushing is still something you do yourself.

---

## 2. The pieces

* **Workspace**: one folder that holds everything for one round of work:
  ```
  my-shop-work/
    repo/            a fresh clone of your repository (your normal working copy is never touched)
    worktrees/a, b   one worktree per AI session (branches masp/a, masp/b)
    preview/         the combined theme: the ONLY folder Shopify serves
    agents/          rules, permissions and start scripts for the AI sessions
    .masp/           MASP's own records (snapshots, journal, logs)
    masp.config.json
  ```
* **Session**: one AI coding session working in one worktree (A, B, C...).
* **Controller** (`masp start`): watches the worktrees and copies finished, safe changes into `preview/`.
  It's the only thing allowed to write into `preview/`.
* **Preview server** (`masp serve`): the one `shopify theme dev`, serving `preview/` to a hidden development theme.
* **Ready** (`masp ready`): a session saying "this change is finished", needed for shared files such as templates.
* **Land** (`masp land`): you, after reviewing the preview, putting it onto your branch as one commit.

---

## 3. Install (once per computer)

Requirements: **Node.js 23.6 or newer** (`node --version`), **Git**, the **Shopify CLI** (`shopify version`), and
**Claude Code** for the AI sessions.

```powershell
npm install -g "C:\tools\masp"      # the folder where you cloned MASP (it holds package.json)
masp --help                               # check that it works
```

That gives you a `masp` command everywhere. MASP is a tool you run; nothing is added to your theme repository.
(Without installing, `node "C:\tools\masp\bin\masp.ts" <command>` does the same.)

---

## 4. Start a piece of work

Pick the branch the finished work should go to. That's `main` if you work alone, or your own branch in a team (see section 10).

```powershell
masp new E:\work\shop-round1 --repo https://github.com/your-org/your-theme.git --branch main --sessions A,B
cd E:\work\shop-round1
```

`--repo` can also be a local folder. MASP clones it, so your existing working copy is never used or changed.

Each session gets file names it owns: session A owns new files named `masp-a-*` (for example `sections/masp-a-hero.liquid`),
session B owns `masp-b-*`. Both may change the shared templates (`templates/**/*.json`, section groups).

---

## 5. A working day

Open one VS Code window on the workspace folder and use one terminal per job.

**Terminal 1: the controller.**
```powershell
masp start
```

**Terminal 2: the one Shopify preview.** Use a development store, never your live store.
```powershell
masp serve --store your-dev-store.myshopify.com
```
The first time, the Shopify CLI asks you to log in in the browser. It prints the preview link (`http://127.0.0.1:9292`).

**Terminals 3, 4...: one per AI session.**
```powershell
masp agent --session A            # shows where session A works and how to start it
& .\agents\start-A.ps1            # starts Claude Code for session A, with its rules and permissions
```

> **Always start a session with its `start-<id>.ps1` script.** Never open a worktree and type plain `claude` there.
> The script is what gives the session its MASP rules (`agents\A.md`) and its limits (`agents\A.settings.json`: only its own
> folder, no Git commits, no Shopify commands, no MCP connectors such as a Shopify store connector).
> A session started without it doesn't know it's session A, doesn't use its file prefix, never runs `masp ready`, and isn't
> stopped from editing other folders or committing. MASP still refuses anything out of scope, but the session will keep fighting it.
> If you need extra Claude Code options, add them after the script: `& .\agents\start-A.ps1 --model <name>`.

Give each session its task in plain words, as usual. The session knows the MASP rules: it works only in its own worktree,
names new files with its prefix, checks its work with `masp lint`, and runs `masp ready` when a change is finished.

If PowerShell refuses to run the script, use `powershell -ExecutionPolicy Bypass -File .\agents\start-A.ps1`.
If `claude` isn't on your PATH (for example when Claude Code came with your editor), point the script at it once per terminal:
`$env:MASP_CLAUDE = "C:\path\to\claude.exe"`.

**Watch what is happening** at any time:
```powershell
masp status       # every session's pending files, conflicts, and what Shopify has received
masp conflicts    # only the problems
masp diff         # everything in the preview that is new, and which session made it
```

---

## 6. How a change reaches the preview

| What the session changed | When it appears in the preview |
|---|---|
| A file it owns (`assets/masp-a-*.css`, `sections/masp-a-*.liquid`...) | **automatically**, a moment after the session stops writing, once every file it uses exists |
| A shared file (templates, section groups) | after `masp ready` |
| A deletion | after `masp ready` |
| Critical files (`layout/theme.liquid`, `config/settings_*.json`) | after `masp ready`, and only if one session exclusively owns them |
| A file it doesn't own | never; MASP reports it as out of scope |

A new workspace gives no session the critical files. If a task needs `layout/theme.liquid` or the theme settings, add the
file to that one session's `owns` list in `masp.config.json` before starting it, for example
`"owns": ["layout/theme.liquid", "assets/masp-a-*", ...]`, then restart `masp start`.

Before anything is copied, MASP checks it: valid JSON and Liquid, every snippet, section, block and asset it uses exists,
and nothing else would break. A file that fails waits ("held") until it's fixed.

`masp status` also shows whether Shopify accepted each upload. If Shopify rejects a file, the reason is shown under the
session that made it.

---

## 7. When two sessions change the same file

This used to be a merge conflict you found later. Now MASP handles it as soon as it happens.

**Combined automatically** (in templates and section groups):
* A adds a section, B adds a different section, in different places.
* A changes the hero section, B changes the FAQ section.
* A removes its own test section while B changes another one.

**Blocked, never guessed** (nothing is overwritten; the session that came second is told):
* Both change the **same section** (even different settings inside it).
* One reorders sections, or deletes the spot where the other inserts.
* Both add a section at exactly the same spot, for example both at the end. You can allow this with `"jsonSamePosition": "after-existing"`
  in `masp.config.json`.
* Both change the same non-JSON file (CSS, Liquid) that isn't exclusively owned.

**How the blocked session fixes it.** It does this itself; you can also do it by hand:
```powershell
masp show templates/index.json                    # the current preview version, and its version id
# merge your change into that version, in your own worktree copy
masp lint  --session B --rebased templates/index.json@<version id>
masp ready --session B --rebased templates/index.json@<version id>
```
`--rebased` means "my file is built on that exact version". If the preview changed again in the meantime, MASP refuses
and you look again. Nobody's work can be silently lost.

---

## 8. Review, then land

1. Open the Shopify preview and review everything together.
2. Look at what would be committed:
   ```powershell
   masp land
   ```
   It lists every file and the session(s) behind it, plus anything that blocks landing or that you should know about.
3. Commit it to your branch:
   ```powershell
   masp land --yes --message "Home page: announcement bar, trust badges, newsletter"
   ```
   This makes **one commit** containing exactly what the preview shows. MASP checks this file by file.
4. Push when you are ready. MASP never pushes:
   ```powershell
   git -C repo push origin main
   ```
   If your branch is connected to a Shopify theme through the GitHub integration, pushing updates that theme.

`masp land` refuses when:
* your branch has new commits the preview doesn't contain, for example a colleague's merge or a commit Shopify's GitHub
  integration made from a Theme Editor change. See section 12.
* someone edited `preview/` by hand, or a publish was interrupted;
* Shopify rejected one of the files, so what you reviewed isn't what Shopify showed. `--force` overrides only this one.

Work that a session hasn't published, or that is blocked, isn't landed. It stays with that session for later.

---

## 9. After landing: keep going

Sessions that are still working aren't disturbed by a landing. To let a finished session continue from the new commit, so it
sees everyone's work:
```powershell
masp resync --session A          # checks first, changes nothing
masp resync --session A --yes    # moves worktree A onto the landed commit
```
Resync refuses if anything would be lost: unpublished changes, an open conflict, published work that isn't landed yet, or
commits of its own on the session branch.

When the round is over, stop everything:
```powershell
masp serve --stop
masp stop
```

---

## 10. Working as a team

Every developer runs **their own** MASP on their own computer, with their own sessions, preview and development theme.
They meet in Git, as before, but with far fewer merges, because each developer's sessions are already combined.

* Give every developer their own branch, and start the workspace from it:
  ```powershell
  masp new E:\work\dev1-round --repo https://github.com/your-org/your-theme.git --branch dev1
  ```
  `masp land` then commits to `dev1`, never to `main`.
* Push `dev1`, open a pull request into `main`, and review and merge as usual.
* When `main` has moved on (someone else's work merged), bring it into your branch the usual way. Then start your next round with a
  fresh `masp new` from the updated branch. Finish and land your current round first: MASP refuses to land onto a branch that moved
  under it, so nothing gets overwritten.

**Shopify development themes:** `shopify theme dev` reuses one development theme per computer and store. Two developers on two
computers each get their own. One developer must not run two `shopify theme dev` for the same store at once.

---

## 11. Rules

**Do**
* Use a development store for `masp serve`.
* Let sessions publish through MASP (`masp ready`); look at `masp status` when something seems stuck.
* Review the Shopify preview before `masp land`.
* Run `masp check` (full Theme Check) before landing big changes.

**Don't**
* Don't edit files in `preview/` by hand. MASP will notice and stop publishing until `masp recover`.
* Don't add `--theme-editor-sync`, `--theme` or `--allow-live` to `shopify theme dev`; `masp serve` already uses the right options.
* Don't run `shopify theme push` or `shopify theme publish` from the workspace.
* Don't commit, rebase or switch branches inside a session's worktree; let `masp land` and `masp resync` handle Git.
* Don't run two controllers or two preview servers for one workspace (MASP refuses anyway).

---

## 12. Old command, new command

| What you want | The old way | With MASP |
|---|---|---|
| Start working | `git worktree add ../a -b feature-a` per session | `masp new <folder> --repo <repo> --sessions A,B` |
| Preview | `shopify theme dev --path ../a` per worktree | `masp serve --store <dev store>` (one for everyone) |
| See what each session did | `git diff` in each worktree | `masp status`, `masp diff` |
| Combine work | `git merge feature-a feature-b`, fix conflicts | automatic for safe changes; `masp conflicts` for the rest |
| Fix a conflict | edit conflict markers, `git add`, `git commit` | `masp show <file>`, merge in the session's copy, `masp ready --rebased ...` |
| Check the theme | `shopify theme check` | `masp lint --session A` (fast, own files), `masp check` (whole preview) |
| Put it on main | merge each branch into main | `masp land --yes` (one commit of what you reviewed) |
| Publish to GitHub | `git push` | `git -C repo push` (unchanged; MASP never pushes) |
| Clean up | `git worktree remove` | `masp serve --stop`, `masp stop`; delete the workspace folder when finished |

---

## 13. When something goes wrong

| You see | What it means | What to do |
|---|---|---|
| `masp status`: a file is `needs-ready` | a shared file or deletion waits for the session's signal | the session runs `masp ready` |
| a session names files without its prefix, edits other folders, tries `git commit`, or never runs `masp ready` | it was started with plain `claude`, not its start script | close it and start it again with `& .\agents\start-<id>.ps1` |
| `held: missing dependency ...` | the file uses a snippet, section, block or asset that isn't in the preview yet | create or publish the missing file; it then goes through together |
| `conflict: section "x" was changed both here and in the preview` | two sessions changed the same section | section 7 |
| `Shopify REJECTED <file>` | Shopify refused the upload (usually a Liquid error) | fix the file; `masp lint --session <id>` shows the error |
| `Local preview: OUT OF SYNC` | something changed `preview/` outside MASP, or a publish was interrupted | `masp verify` to see what; `masp recover` (add `--restore-preview` to put MASP's versions back; the outside versions are kept) |
| `CANNOT LAND: 'main' has moved since the preview was built` | new commits arrived on your branch | land nothing over them: finish this round, then start a new workspace from the updated branch |
| `another MASP writer is running` | a controller is already running for this workspace | use that one, or `masp stop` it |
| port 9292 busy after a crash | a Shopify process was left behind | `masp serve --stop` stops the whole process tree |

---

## 14. Limits to know

* MASP doesn't merge inside one section, and doesn't merge plain files (CSS, Liquid) changed by two sessions. It blocks them,
  and the session merges by hand.
* Its own checks are static. They catch broken JSON, broken Liquid structure and missing files. `masp lint` adds Shopify Theme
  Check's syntax checks. Neither proves the page looks right; that's what your review in the preview is for.
* Bringing new commits from your branch into a running workspace isn't supported yet. Start a new workspace instead.
* AI session permissions are a strong fence, not a sandbox. MASP's own checks are the safety net behind them.

More detail: [architecture.md](architecture.md) (how it works and what was tested), [providers.md](providers.md) (Claude Code and
OpenCode settings).
