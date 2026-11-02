// Stand-in for `shopify theme dev` in tests: no network. Prints the same kind of lines the real
// CLI prints ("Synced » update <path>") whenever a file in --path changes.
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const root = args[args.indexOf("--path") + 1];
const stamp = () => new Date().toTimeString().slice(0, 8);
console.log("╭─ success ─╮\n│  Preview your theme (t)  │\n╰───────────╯\n[1] http://127.0.0.1:9292");
const pending = new Map();
fs.watch(root, { recursive: true }, (_ev, f) => {
  if (!f) return;
  const rel = String(f).split(path.sep).join("/");
  if (!/^(assets|blocks|config|layout|locales|sections|snippets|templates)\//.test(rel)) return;
  clearTimeout(pending.get(rel));
  pending.set(rel, setTimeout(() => {
    const exists = fs.existsSync(path.join(root, rel));
    if (rel.includes("fail-upload")) console.log(`╭─ error ─────╮\n│  Failed to upload file "${rel}" to remote theme.  │\n│  Liquid syntax error (line 1): simulated  │\n╰─────────────╯`);
    else console.log(`• ${stamp()}  Synced » ${exists ? "update" : "delete"} ${rel}`);
  }, 150));
});
setInterval(() => {}, 1 << 30);
