// Reconcile N agent JSON outputs into write decisions.
//
// Input: agent-A1.json, agent-A2.json, ... in this directory.
// Output: stdout report + (optionally) write to persons/candidates with --apply.
//
// Logic per (person_id, field):
//   - 2+ agents propose the SAME value with conf >= 0.7 → high confidence, write to persons
//   - 2+ agents propose DIFFERENT values → flag (investigate; both go to candidates)
//   - 1 agent proposes (no second voice) → candidate row
//   - 0 agents propose → skip

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "/Users/xingzewang/Desktop/mail/scripts/agent-runs";
const APPLY = process.argv.includes("--apply");

// Load all agent JSON files
const agentFiles = readdirSync(DIR)
  .filter((f) => /^agent-.+\.json$/.test(f))
  .sort();
console.log(`Loading ${agentFiles.length} agent outputs:`, agentFiles);

const byPersonByField = new Map();
// shape: person_id -> field -> [{ agent, value, confidence, evidence }, ...]

for (const fname of agentFiles) {
  const agent = fname.replace(/^agent-(.+)\.json$/, "$1");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(DIR, fname), "utf8"));
  } catch (e) {
    console.warn(`  parse failed for ${fname}: ${e.message}`);
    continue;
  }
  for (const entry of parsed ?? []) {
    const pid = entry.person_id;
    if (!pid) continue;
    if (!byPersonByField.has(pid)) byPersonByField.set(pid, new Map());
    const fields = byPersonByField.get(pid);
    const props = entry.proposals ?? {};
    for (const [field, val] of Object.entries(props)) {
      if (!fields.has(field)) fields.set(field, []);
      // value can be { value, confidence, evidence } or [{value, confidence, evidence}, ...]
      const items = Array.isArray(val) ? val : [val];
      for (const item of items) {
        if (!item || item.value == null) continue;
        fields.get(field).push({
          agent,
          value: String(item.value),
          confidence: Number(item.confidence) || 0,
          evidence: item.evidence ?? [],
        });
      }
    }
  }
}

// Reconcile
const writes = []; // { pid, email, field, value, agents, confidence }
const candidates = []; // { pid, field, value, agents, reason }

for (const [pid, fields] of byPersonByField) {
  for (const [field, props] of fields) {
    // Group by normalized value (case-insensitive for usernames)
    const groups = new Map();
    for (const p of props) {
      const key = p.value.toLowerCase().trim();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
    const top = sortedGroups[0];
    const second = sortedGroups[1];

    if (top[1].length >= 2) {
      // 2+ agents agree on the same value
      const agentsAgreed = top[1].map((p) => p.agent);
      const avgConf = top[1].reduce((s, p) => s + p.confidence, 0) / top[1].length;
      if (avgConf >= 0.7) {
        // Strong write candidate
        writes.push({
          pid,
          field,
          value: top[1][0].value, // use the original casing from first agent
          agents: agentsAgreed,
          confidence: Number(avgConf.toFixed(2)),
          evidence: top[1].flatMap((p) => p.evidence).slice(0, 6),
        });
        // Disagreement check
        if (second && second[1].length >= 1) {
          candidates.push({
            pid,
            field,
            reason: `dispute: ${agentsAgreed.length} agents say "${top[0]}", ${second[1].length} say "${second[0]}"`,
            value: second[1][0].value,
            agents: second[1].map((p) => p.agent),
          });
        }
        continue;
      }
    }

    // No agreement OR only 1 agent reported anything → all go to candidates
    for (const [, items] of sortedGroups) {
      candidates.push({
        pid,
        field,
        value: items[0].value,
        agents: items.map((p) => p.agent),
        confidence: items.reduce((s, p) => s + p.confidence, 0) / items.length,
        reason: items.length === 1 ? "single-agent" : `low-conf-agreement (${items.length} agents, avg ${(items.reduce((s, p) => s + p.confidence, 0) / items.length).toFixed(2)})`,
      });
    }
  }
}

console.log(`\n=== Reconcile result ===`);
console.log(`HIGH-CONF writes (≥2 agents agree, avg conf ≥0.7): ${writes.length}`);
for (const w of writes) {
  console.log(`  ${w.field} = ${JSON.stringify(w.value)} (agents: ${w.agents.join("+")}, conf ${w.confidence})`);
}
console.log(`\nCANDIDATES (single-source or low-conf): ${candidates.length}`);
for (const c of candidates.slice(0, 20)) {
  console.log(`  ${c.field} = ${JSON.stringify(c.value).slice(0, 60)} — ${c.reason}`);
}
if (candidates.length > 20) console.log(`  ...and ${candidates.length - 20} more`);

writeFileSync(join(DIR, "reconcile-output.json"), JSON.stringify({ writes, candidates }, null, 2));
console.log(`\nFull output: ${join(DIR, "reconcile-output.json")}`);

if (APPLY) {
  console.log(`\n--apply set; would write ${writes.length} fields to persons + ${candidates.length} to candidates`);
  // Actual write logic goes here when ready
} else {
  console.log(`\n(dry run. pass --apply to actually write to DB)`);
}
