// Loads attack files (Markdown + YAML-ish frontmatter) from disk.
// Intentionally avoids a YAML dep — the frontmatter we use is a small subset.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Attack, AttackFrontmatter, Category, Severity } from "./types.js";

const VALID_CATEGORIES: Category[] = [
  "jailbreak",
  "prompt-injection",
  "role-play-extraction",
  "system-prompt-leak",
  "training-data-extraction",
  "financial-bait",
  "legal-bait",
  "identity-leak",
  "multi-turn-manipulation",
];

const VALID_SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];

export function loadAttacks(dir: string): Attack[] {
  const abs = resolve(dir);
  const files = readdirSync(abs)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(abs, f))
    .filter((p) => statSync(p).isFile())
    .sort();

  return files.map((p) => parseAttackFile(p));
}

export function loadAttacksByIds(dir: string, ids: string[]): Attack[] {
  const all = loadAttacks(dir);
  const set = new Set(ids);
  const found = all.filter((a) => set.has(a.id));
  const foundIds = new Set(found.map((a) => a.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new Error(`Unknown attack id(s): ${missing.join(", ")}`);
  }
  return found;
}

function parseAttackFile(path: string): Attack {
  const raw = readFileSync(path, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    throw new Error(`Attack file ${path} missing --- frontmatter ---`);
  }
  const fm = parseFrontmatter(m[1], path);
  const prompt = m[2].trim();
  if (!prompt) {
    throw new Error(`Attack file ${path} has empty prompt body`);
  }
  return { ...fm, prompt, source_path: path };
}

// Minimal YAML-ish parser: supports `key: value`, `key: |` block scalars,
// and `key:\n  - item` lists. Good enough for our schema; nothing fancier.
function parseFrontmatter(text: string, path: string): AttackFrontmatter {
  const lines = text.split("\n");
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    const kv = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1];
    const rest = kv[2];

    if (rest === "|") {
      // block scalar: gather indented lines
      i++;
      const block: string[] = [];
      while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
        block.push(lines[i].replace(/^ {2}/, ""));
        i++;
      }
      out[key] = block.join("\n").trim();
    } else if (rest === "") {
      // possibly a list
      i++;
      const list: string[] = [];
      while (i < lines.length && lines[i].startsWith("  - ")) {
        list.push(lines[i].slice(4).trim());
        i++;
      }
      out[key] = list;
    } else {
      out[key] = stripQuotes(rest.trim());
      i++;
    }
  }

  return validateFrontmatter(out, path);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function validateFrontmatter(o: Record<string, unknown>, path: string): AttackFrontmatter {
  const required = [
    "id",
    "category",
    "severity",
    "title",
    "description",
    "expected_safe_behavior",
    "expected_unsafe_behavior",
  ];
  for (const k of required) {
    if (!o[k]) throw new Error(`Attack ${path} missing required field: ${k}`);
  }
  const category = String(o.category) as Category;
  const severity = String(o.severity) as Severity;
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Attack ${path} has invalid category: ${category}`);
  }
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(`Attack ${path} has invalid severity: ${severity}`);
  }
  const refs = Array.isArray(o.references) ? (o.references as string[]) : [];
  return {
    id: String(o.id),
    category,
    severity,
    title: String(o.title),
    description: String(o.description),
    expected_safe_behavior: String(o.expected_safe_behavior),
    expected_unsafe_behavior: String(o.expected_unsafe_behavior),
    references: refs,
  };
}
