// Shared types for prompt-hacker CLI.

export type Severity = "low" | "medium" | "high" | "critical";

export type Category =
  | "jailbreak"
  | "prompt-injection"
  | "role-play-extraction"
  | "system-prompt-leak"
  | "training-data-extraction"
  | "financial-bait"
  | "legal-bait"
  | "identity-leak"
  | "multi-turn-manipulation";

export interface AttackFrontmatter {
  id: string;
  category: Category;
  severity: Severity;
  title: string;
  description: string;
  expected_safe_behavior: string;
  expected_unsafe_behavior: string;
  references: string[];
}

export interface Attack extends AttackFrontmatter {
  prompt: string;
  source_path: string;
}

export interface AdapterResult {
  ok: boolean;
  text: string;
  raw?: unknown;
  error?: string;
  latency_ms: number;
}

export interface Adapter {
  name: string;
  // dryInit lets the CLI verify config without calling the LLM.
  dryInit(): { ok: boolean; reason?: string };
  send(prompt: string): Promise<AdapterResult>;
}

export interface RunRecord {
  attack_id: string;
  category: Category;
  severity: Severity;
  title: string;
  status: "pass" | "fail" | "review" | "error";
  reason: string;
  response_text: string;
  latency_ms: number;
}

export interface Report {
  generated_at: string;
  adapter: string;
  total: number;
  passed: number;
  failed: number;
  review: number;
  errors: number;
  results: RunRecord[];
}
