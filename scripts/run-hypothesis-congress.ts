/**
 * Run the hypothesis-driven congress directly from CLI, bypassing the
 * Vercel HTTP layer (which gets challenged from rate-flagged IPs).
 *
 * Lazy-imports the TS runner via tsx (or the compiled .js if Vercel's
 * build output is around). Uses .env.local for GOOGLE_API_KEY +
 * Supabase credentials (the runner reads these via the standard
 * llm-proxy + db modules).
 *
 * Run with: set -a && source .env.local && set +a && \
 *   npx tsx scripts/run-hypothesis-congress.mjs
 */

// Use tsx's runtime to import the .ts source. Same pattern as
// scripts/lark-bot-worker.ts (which is .ts directly).
import { runHypothesisCongress } from "../src/lib/congress-hypothesis.ts";

async function main() {
  const result = await runHypothesisCongress({ lookbackDays: 30 });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
