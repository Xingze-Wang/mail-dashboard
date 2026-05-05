#!/usr/bin/env node
// prompt-hacker CLI entrypoint.
//
// Usage:
//   prompt-hacker run [--adapter NAME] [--attacks-dir DIR] [--ids id1,id2]
//                     [--out reports/run.json] [--dry-run]
//   prompt-hacker list [--attacks-dir DIR]
//
// Adapter config is read from env. See README.md.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadAttacks, loadAttacksByIds } from "./loader.js";
import { getAdapter } from "./adapters.js";
import { judge } from "./judge.js";
import type { Attack, Report, RunRecord } from "./types.js";

interface Args {
  command: "run" | "list" | "help";
  adapter: string;
  attacksDir: string;
  ids: string[] | null;
  out: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: "help",
    adapter: process.env.PROMPT_HACKER_ADAPTER ?? "openai",
    attacksDir: "attacks",
    ids: null,
    out: `reports/run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    dryRun: false,
  };
  if (argv.length === 0) return a;
  a.command = (argv[0] as Args["command"]) ?? "help";
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--adapter":
        a.adapter = v;
        i++;
        break;
      case "--attacks-dir":
        a.attacksDir = v;
        i++;
        break;
      case "--ids":
        a.ids = v.split(",").map((s) => s.trim()).filter(Boolean);
        i++;
        break;
      case "--out":
        a.out = v;
        i++;
        break;
      case "--dry-run":
        a.dryRun = true;
        break;
      case "-h":
      case "--help":
        a.command = "help";
        break;
    }
  }
  return a;
}

function helpText(): string {
  return `prompt-hacker — run jailbreak/injection prompts against an LLM endpoint.

Commands:
  list                          List attacks in the catalog.
  run                           Run attacks against the configured adapter.
  help                          Show this help.

Options for run:
  --adapter NAME                openai (default), webhook, echo
  --attacks-dir DIR             default ./attacks
  --ids a,b,c                   only run these attack ids (comma-separated)
  --out PATH                    JSON report path (default reports/run-<ts>.json)
  --dry-run                     load attacks + init adapter, do NOT call LLM

OpenAI-compatible adapter env:
  PROMPT_HACKER_BASE_URL        default https://api.openai.com/v1
  PROMPT_HACKER_API_KEY         (required for live runs)
  PROMPT_HACKER_MODEL           default gpt-4o-mini
  PROMPT_HACKER_SYSTEM          optional system message

Webhook adapter env:
  PROMPT_HACKER_WEBHOOK_URL     POST endpoint
  PROMPT_HACKER_WEBHOOK_AUTH    bearer token (optional)
  PROMPT_HACKER_WEBHOOK_REPLY_KEY   field in response JSON (default "reply")
`;
}

async function cmdList(args: Args): Promise<number> {
  const attacks = loadAttacks(args.attacksDir);
  console.log(`Loaded ${attacks.length} attacks from ${resolve(args.attacksDir)}\n`);
  for (const a of attacks) {
    console.log(`  ${pad(a.id, 32)} ${pad(a.severity, 10)} ${a.category}`);
  }
  return 0;
}

async function cmdRun(args: Args): Promise<number> {
  const attacks = args.ids
    ? loadAttacksByIds(args.attacksDir, args.ids)
    : loadAttacks(args.attacksDir);

  const adapter = getAdapter(args.adapter);
  const init = adapter.dryInit();
  if (!init.ok && !args.dryRun) {
    console.error(`Adapter ${adapter.name} not ready: ${init.reason}`);
    return 2;
  }

  console.log(`Adapter: ${adapter.name}`);
  console.log(`Attacks: ${attacks.length}`);
  if (args.dryRun) {
    console.log(`(dry-run — not calling LLM)\n`);
    for (const a of attacks) {
      console.log(`  loaded: ${pad(a.id, 32)} ${pad(a.severity, 10)} (${a.prompt.length}c)`);
    }
    return 0;
  }
  console.log("");

  const results: RunRecord[] = [];
  for (const a of attacks) {
    process.stdout.write(`  ${pad(a.id, 32)} ${pad(a.severity, 8)} ... `);
    const r = await adapter.send(a.prompt);
    const verdict = judge(a, r.text, r.error);
    results.push({
      attack_id: a.id,
      category: a.category,
      severity: a.severity,
      title: a.title,
      status: verdict.status,
      reason: verdict.reason,
      response_text: r.text,
      latency_ms: r.latency_ms,
    });
    console.log(`${tag(verdict.status)} (${r.latency_ms}ms) — ${verdict.reason}`);
  }

  const report: Report = {
    generated_at: new Date().toISOString(),
    adapter: adapter.name,
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    review: results.filter((r) => r.status === "review").length,
    errors: results.filter((r) => r.status === "error").length,
    results,
  };

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log(
    `Summary: ${report.passed} pass / ${report.failed} fail / ${report.review} review / ${report.errors} error`,
  );
  console.log(`Report: ${outPath}`);

  // Non-zero exit if anything failed — useful for CI.
  return report.failed > 0 ? 1 : 0;
}

function tag(s: RunRecord["status"]): string {
  switch (s) {
    case "pass":
      return "PASS  ";
    case "fail":
      return "FAIL  ";
    case "review":
      return "REVIEW";
    case "error":
      return "ERROR ";
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let code = 0;
  switch (args.command) {
    case "list":
      code = await cmdList(args);
      break;
    case "run":
      code = await cmdRun(args);
      break;
    case "help":
    default:
      console.log(helpText());
      break;
  }
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
