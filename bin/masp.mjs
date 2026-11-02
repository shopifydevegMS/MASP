#!/usr/bin/env node
// Launcher for the `masp` command. Plain JavaScript on purpose: it must be able to explain a broken
// install before Node tries to load any TypeScript.
//
// Node only runs TypeScript files that are NOT inside node_modules. `npm install -g <clone folder>` links
// to the clone, so the real path is outside node_modules and works. `npm install -g github:...` copies MASP
// into node_modules, where every command would crash with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fs.realpathSync(path.dirname(fileURLToPath(import.meta.url)));
const [major, minor] = process.versions.node.split(".").map(Number);

const fail = (msg) => {
  console.error(`MASP: ${msg}`);
  process.exit(1);
};

if (major < 23 || (major === 23 && minor < 6)) fail(`Node.js 23.6 or newer is required (this is ${process.version}).`);

if (here.split(path.sep).includes("node_modules")) {
  fail(`MASP is installed inside node_modules (${here}), where Node cannot run its TypeScript files.
Install it from a clone instead:

  npm uninstall -g masp
  git clone https://github.com/shopifydevegMS/MASP.git C:\\tools\\masp
  npm install -g C:\\tools\\masp

Keep that folder: the 'masp' command links to it, and 'git pull' there updates MASP.`);
}

await import(pathToFileURL(path.join(here, "masp.ts")).href);
