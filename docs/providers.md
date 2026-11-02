# Using MASP with Claude Code or OpenCode

MASP does not depend on either tool. A session only needs to:

1. edit files in its own worktree, and
2. run `masp ready --session <id>` when a change is finished.

The rules each session follows are in [agent-instructions.md](agent-instructions.md) (with `{{SESSION}}`,
`{{OWNS}}`, `{{SHARED}}` and `{{PREFIX}}` filled in).
**Instructions are not permissions.** The settings below block the risky actions. MASP itself also refuses
out-of-scope publishes and detects any edit to the preview.

## Claude Code

### Headless (what Phase 5 used)

`examples/run-agents.ts` starts one session per worktree:

```
node examples/run-agents.ts --config <masp.config.json> --claude <path to claude.exe> --task-A "..." --task-B "..."
```

For each session it runs `claude -p "<task>"` in the worktree with:

| Option | Why |
|---|---|
| `--append-system-prompt-file agents/<id>.md` | the MASP rules |
| `--settings agents/<id>.settings.json` | allow and deny rules (below) |
| `--setting-sources project,local` | ignore your global settings and their broader allow rules |
| `--strict-mcp-config` | no MCP servers: a Shopify connector could otherwise change the real store |
| `--permission-mode acceptEdits` | edits inside the worktree are allowed; anything not on the allow list is refused, since nobody is there to approve it |
| `MASP_CONFIG`, `MASP_SESSION`, a `masp` wrapper on `PATH` | so the session can type `masp ready ...` |

Permission rules (written by the script):

* **Allowed:** Read, Glob, Grep, Edit, Write; Bash only for `masp ready|lint|status|show|conflicts|diff`,
  `git status|diff|log`, and `ls`.
* **Denied:** editing anything under the preview, `.masp`, the repo, the agents folder, or another session's worktree
  (rules like `Edit(//d/work/round1/preview/**)`); `git commit|push|reset|checkout|switch|stash|rebase|merge|branch|worktree|restore|clean|tag|...`;
  `shopify`; WebFetch; WebSearch.

The session log (`agents/<id>.log.jsonl`) records every tool call, so you can audit afterwards.

### Interactive (one VS Code window, one terminal per session)

In each terminal:

```powershell
cd <masp root>\worktrees\a
$env:MASP_CONFIG = "<masp root>\masp.config.json"; $env:MASP_SESSION = "A"
$env:PATH = "<masp root>\agents\bin;$env:PATH"
claude --append-system-prompt-file <masp root>\agents\A.md --settings <masp root>\agents\A.settings.json --strict-mcp-config
```

Run `run-agents.ts` once without tasks to generate the `agents/` files, or copy them from a Phase 5 run.

Known limits: `acceptEdits` also auto-approves simple file commands such as `rm` and `mkdir` inside the worktree, even when they
are not on the allow list. They cannot reach outside the worktree, but the shell fence is wider than the list suggests.
Bash rules match command prefixes, so they only partly cover shell tricks. The sandbox feature is not
available on native Windows. MASP's checks (scope, outside-edit detection, the read-only Git wrapper) are the backstop.

## OpenCode (not tested in this prototype)

OpenCode reads `AGENTS.md`, not `CLAUDE.md`. Its v1 plugins do not work in v2.

* Put the filled-in rules into the worktree's `AGENTS.md`. Exclude it with `.git/info/exclude` rather than
  committing it, or keep it outside and reference it from your OpenCode config `instructions`.
* OpenCode v2 lets an agent write outside its project folder by default, so add explicit deny rules in
  `opencode.json`, for example:

```json
{
  "permission": {
    "edit": "allow",
    "bash": {
      "masp *": "allow",
      "git status*": "allow",
      "git diff*": "allow",
      "git log*": "allow",
      "*": "deny"
    },
    "external_directory": "deny",
    "webfetch": "deny"
  }
}
```

* Set `MASP_CONFIG` and `MASP_SESSION`, and put the `masp` wrapper on `PATH`, exactly as for Claude Code.
* Check the permission key names against `opencode --help` and its documentation for your installed version
  (2.0.27 at the time of the audit) before relying on them.
