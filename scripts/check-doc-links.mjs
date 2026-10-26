#!/usr/bin/env node
// Check relative links, images, and heading anchors across a repository's Markdown.
//
// Usage: node check-doc-links.mjs [root]
//
// Exits 1 when anything is broken, so it can gate CI. No dependencies.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";

const SKIP_DIRS = new Set([".git", ".cache", "node_modules", "dist", "build", "out", "coverage", ".next"]);
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

const root = resolve(process.argv[2] ?? ".");

if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`check-doc-links: not a directory: ${root}`);
  process.exit(2);
}

function walk(dir, output = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walk(full, output);
    } else if (entry.endsWith(".md")) {
      output.push(full);
    }
  }
  return output;
}

/** Strip fenced blocks (with backticks or tildes) and inline code so samples never count as links. */
function stripCode(text) {
  return text
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

/** GitHub heading slug: lowercase, punctuation dropped, spaces to hyphens. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .trim()
    .replace(/ +/g, "-");
}

function anchorsOf(file) {
  const text = stripCode(readFileSync(file, "utf8"));
  const anchors = new Set();
  for (const [, heading] of text.matchAll(/^ {0,3}#{1,6} +(.+?)\s*#*\s*$/gm)) {
    anchors.add(slug(heading));
  }
  // Explicit targets: <a id="x">, <a name="x">, and headings with {#x}.
  for (const [, id] of text.matchAll(/<a\s+(?:id|name)="([^"]+)"/gi)) anchors.add(id.toLowerCase());
  for (const [, id] of text.matchAll(/\{+#([\w-]+)\}?\s*$/gm)) anchors.add(id.toLowerCase());
  return anchors;
}

const files = walk(root);
const anchorCache = new Map();
const problems = [];

function anchorsFor(file) {
  let cached = anchorCache.get(file);
  if (cached === undefined) {
    cached = anchorsOf(file);
    anchorCache.set(file, cached);
  }
  return cached;
}

for (const file of files) {
  const text = stripCode(readFileSync(file, "utf8"));
  const targets = [
    ...[...text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]),
    ...[...text.matchAll(/^ {0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm)].map((m) => m[1]),
  ];

  for (const target of targets) {
    if (target === "" || EXTERNAL.test(target)) continue;
    const [rawPath, rawFragment] = target.split("#");
    const path = decodeURIComponent(rawPath);

    let destination = rawPath === "" ? file : resolve(dirname(file), path);
    let anchorFile = destination;

    if (rawPath !== "" && !existsSync(destination)) {
      // Allow linking to a directory's README.
      const readme = join(destination, "README.md");
      if (existsSync(readme)) {
        destination = readme;
        anchorFile = readme;
      } else {
        problems.push(`${relative(root, file)}: missing target "${target}"`);
        continue;
      }
    }

    if (rawFragment === undefined || rawFragment === "") continue;
    if (!anchorFile.endsWith(".md")) continue; // anchors on assets/source files are not ours to check

    const fragment = decodeURIComponent(rawFragment).toLowerCase();
    if (!anchorsFor(anchorFile).has(fragment)) {
      problems.push(`${relative(root, file)}: no anchor "#${rawFragment}" in ${relative(root, anchorFile)}`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-doc-links: ${problems.length} problem(s) in ${files.length} files`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check-doc-links: ${files.length} files ok${sep === "/" ? "" : ""}`);
