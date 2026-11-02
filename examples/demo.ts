// Reproducible demo: two simulated agents, one controller, one unified preview.
//   node examples/demo.ts           build sandbox/demo and run the scenario
//   node examples/demo.ts --fresh   delete a previous sandbox/demo first (only if MASP created it)
// No AI model and no Shopify connection are involved.
import fs from "node:fs";
import path from "node:path";
import { Sandbox, ROOT, waitFor } from "../test/harness.ts";
import * as cmd from "../src/commands.ts";

const DEMO = path.join(ROOT, "sandbox", "demo");
const MARKER = path.join(DEMO, ".masp-demo");

if (fs.existsSync(DEMO)) {
  if (!process.argv.includes("--fresh")) {
    console.error(`${DEMO} already exists. Re-run with --fresh to rebuild it.`);
    process.exit(1);
  }
  if (!fs.existsSync(MARKER)) {
    console.error(`${DEMO} was not created by this demo (no marker file); not deleting it.`);
    process.exit(1);
  }
  // Windows: VS Code Git scanning or antivirus can hold files briefly.
  fs.rmSync(DEMO, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

const step = (n: number, title: string) => console.log(`\n=== ${n}. ${title}`);
const show = (r: { stdout: string; stderr: string }) => process.stdout.write((r.stdout + r.stderr).replace(/^/gm, "    "));
const timings: Record<string, number> = {};

const sb = new Sandbox("demo", { root: DEMO, settleMs: 300 });
fs.writeFileSync(MARKER, "created by examples/demo.ts\n");
console.log(`Sandbox: ${DEMO}`);
console.log(`  repo\\           throwaway Git repo (baseline commit made by the demo harness)`);
console.log(`  worktrees\\a, b  one Git worktree per simulated agent`);
console.log(`  preview\\        the unified preview: the only folder 'shopify theme dev' would use`);
console.log(`  .masp\\          MASP state, snapshots, journal, checkpoints (outside Git and the theme)`);

step(1, "Start one controller (no Shopify server is started)");
const ctl = sb.startController();
await waitFor(() => (ctl as any).output().includes("controller started"), 15000, "controller");
console.log(`    controller pid ${ctl.pid}`);

step(2, "Agent A edits assets/dev1.css, agent B edits assets/dev2.css (auto-published)");
let t0 = Date.now();
sb.write("A", "assets/dev1.css", "/* A */\n.a-banner { padding: 4rem; background: #fde68a; }\n");
sb.write("B", "assets/dev2.css", "/* B */\n.b-promo { padding: 2rem; background: #bfdbfe; }\n");
await waitFor(() => /4rem/.test(sb.readPreview("assets/dev1.css") ?? "") && /bfdbfe/.test(sb.readPreview("assets/dev2.css") ?? ""));
timings["edit -> preview (auto, settle 300 ms)"] = Date.now() - t0;
console.log(`    both in the preview after ${timings["edit -> preview (auto, settle 300 ms)"]} ms`);

step(3, "Agent A adds a section that renders a snippet it has not written yet");
sb.write("A", "sections/a-promo.liquid", `<section class="a-banner">\n  {% render 'a-badge', text: section.settings.text %}\n</section>\n{% schema %}\n{ "name": "A promo", "settings": [{ "type": "text", "id": "text", "label": "Text", "default": "New" }], "presets": [{ "name": "A promo" }] }\n{% endschema %}\n`);
await new Promise((r) => setTimeout(r, 1500));
console.log(`    in preview? ${sb.readPreview("sections/a-promo.liquid") ? "yes" : "no (held: missing snippet)"}`);
show(sb.masp(["conflicts"]));
sb.write("A", "snippets/a-badge.liquid", `<span class="badge">{{ text }}</span>\n`);
await waitFor(() => sb.readPreview("sections/a-promo.liquid") !== null);
console.log("    after the snippet appears, both files are published in one transaction");

step(4, "Agent A adds its section to the home page and signals Ready");
sb.editJson("A", "templates/index.json", (v) => {
  v.sections.a_promo = { type: "a-promo", settings: { text: "Hello from A" } };
  v.order.push("a_promo");
});
t0 = Date.now();
show(sb.masp(["ready", "--session", "A", "--message", "add A promo to home"]));
timings["ready -> preview"] = Date.now() - t0;

step(5, "Agent B changes the hero heading in the same template, starting from the old version");
sb.editJson("B", "templates/index.json", (v) => (v.sections.hero.settings.heading = "Spring sale"));
show(sb.masp(["ready", "--session", "B"]));
console.log("    B changed a different section than A, so the change is merged; A's section stays.");

step(6, "Both agents change the same section: the second one is blocked");
sb.editJson("A", "templates/index.json", (v) => (v.sections.featured_text.settings.text = "Text from A"));
show(sb.masp(["ready", "--session", "A"]));
sb.editJson("B", "templates/index.json", (v) => (v.sections.featured_text.settings.text = "Text from B"));
show(sb.masp(["ready", "--session", "B"]));

step(7, "Agent B reviews the preview version, merges by hand and signals with that version");
const shown = cmd.show(sb.ctx(), "templates/index.json");
sb.write("B", "templates/index.json", shown.content!);
sb.editJson("B", "templates/index.json", (v) => (v.sections.featured_text.settings.text = "Text from A and B, merged by B"));
show(sb.masp(["ready", "--session", "B", "--rebased", `templates/index.json@${shown.hash!.slice(0, 16)}`]));

step(8, "Status and provenance");
show(sb.masp(["status"]));
show(sb.masp(["diff"]));
show(sb.masp(["verify"]));

step(9, "Idle for 5 s, then stop the controller");
await new Promise((r) => setTimeout(r, 5000));
show(sb.masp(["stop"]));
await waitFor(() => ctl.exitCode !== null, 15000);
const stats = JSON.parse(fs.readFileSync(path.join(sb.data, "controller-stats.json"), "utf8"));

step(10, "Measurements (this machine, this tiny fixture)");
const cps = sb.ctx().store.listCheckpoints().filter((c: any) => c.outcome === "published");
console.log(`    controller processes: 1   Shopify dev servers started by MASP: 0`);
for (const [k, v] of Object.entries(timings)) console.log(`    ${k}: ${v} ms`);
console.log(`    publish latency per checkpoint (stable/ready -> published): ${cps.map((c: any) => c.latencyMs + " ms").join(", ")}`);
console.log(`    controller: ${stats.passes} passes in ${(stats.uptimeMs / 1000).toFixed(1)} s, ${stats.cpuMs} ms CPU total, peak memory ${stats.peakRssMB} MB, ${stats.filesHashed} file reads for hashing`);
console.log(`\nDone. Explore with: node bin/masp.ts status --config "${sb.config}"`);
