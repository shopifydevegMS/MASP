// `masp new`: a workspace from a Git repository in one step; the source repository is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { Sandbox, BIN } from "./harness.ts";
import { openCtx } from "../src/context.ts";
import * as cmd from "../src/commands.ts";
import { land } from "../src/land.ts";

const g = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("masp new: clone + worktrees + preview + agent files; landing stays in the workspace clone", async (t) => {
  const src = new Sandbox("new-src", { init: false }); // only its repo is used, as "the developer's project"
  const ws = path.join(src.root, "workspace");
  t.after(() => src.cleanup());
  const srcRefs = g(src.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);

  const r = spawnSync(process.execPath, [BIN, "new", ws, "--repo", src.repo, "--sessions", "A,B,C", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.branch, "main");
  assert.equal(out.baseCommit, src.baseCommit);
  for (const p of ["repo/layout/theme.liquid", "preview/templates/index.json", "worktrees/a", "worktrees/b", "worktrees/c", "masp.config.json",
    "agents/A.md", "agents/B.settings.json", "agents/start-C.ps1", "agents/bin/masp", "agents/bin/masp.cmd"])
    assert.ok(fs.existsSync(path.join(ws, p)), p);
  assert.equal(g(path.join(ws, "worktrees", "b"), ["rev-parse", "--abbrev-ref", "HEAD"]), "masp/b");

  const ctx = openCtx(path.join(ws, "masp.config.json"), () => {});
  assert.equal(ctx.cfg.landBranch, "main");
  assert.deepEqual(cmd.status(ctx).sessions.map((s) => [s.id, s.registered]), [["A", true], ["B", true], ["C", true]]);
  assert.deepEqual(ctx.cfg.sessions[1].owns, ["assets/masp-b-*", "sections/masp-b-*.liquid", "snippets/masp-b-*.liquid", "blocks/masp-b-*.liquid"]);
  assert.match(fs.readFileSync(path.join(ws, "agents", "A.md"), "utf8"), /coding session \*\*A\*\*[\s\S]*masp-a-/);
  const perms = JSON.parse(fs.readFileSync(path.join(ws, "agents", "A.settings.json"), "utf8")).permissions;
  assert.ok(perms.deny.some((d: string) => d.includes("/preview/**")) && perms.deny.includes("Bash(masp land:*)"));

  // The PowerShell start script parses; the masp.cmd helper runs.
  const ps = spawnSync("powershell", ["-NoProfile", "-Command",
    `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(ws, "agents", "start-A.ps1")}', [ref]$null, [ref]$e); $e.Count`], { encoding: "utf8" });
  assert.equal(ps.stdout.trim(), "0", ps.stderr);
  const viaCmd = spawnSync("cmd", ["/c", path.join(ws, "agents", "bin", "masp.cmd"), "status"], { encoding: "utf8", env: { ...process.env, MASP_CONFIG: path.join(ws, "masp.config.json") } });
  assert.match(viaCmd.stdout, /Session C \(session C\): active/);

  // A session works, the developer lands: the commit is in the workspace clone only.
  fs.writeFileSync(path.join(ws, "worktrees", "a", "assets", "masp-a-hello.css"), ".hello { color: red; }\n");
  await cmd.integrate(ctx);
  const landed = land(ctx, { yes: true, message: "hello" });
  assert.equal(landed.recorded, "landed");
  assert.equal(g(path.join(ws, "repo"), ["rev-parse", "main"]), landed.commit);
  assert.equal(g(src.repo, ["for-each-ref", "--format=%(refname) %(objectname)"]), srcRefs, "the source repository is untouched (nothing pushed)");
  // Refuses an existing non-empty folder.
  const again = spawnSync(process.execPath, [BIN, "new", ws, "--repo", src.repo], { encoding: "utf8" });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists and is not empty/);
});
