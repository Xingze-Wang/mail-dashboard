// Curated list of high-signal AI industry orgs. Detection works two ways:
//   1. Token match in S2 author affiliations (most reliable)
//   2. Regex match in arxiv paper acknowledgments / footnotes
//      (e.g. "Work done while interning at OpenAI")
//
// Anything matching gets normalized to a canonical name, dedup'd, and stored
// on pipeline_leads.industry_orgs. Sales sees a 🏢 badge; the strength
// scorer adds a citation-equivalent bonus (+2000) to the lead's tier
// classification — an Anyscale intern with 200 cites is much stronger than
// a random PhD with 200 cites.

export interface OrgDef {
  canonical: string;        // display name
  match: RegExp;            // case-insensitive, used on both S2 + ack text
  emoji?: string;
}

// Order matters — first match wins. Put aliases together (e.g. "Google
// Brain" before generic "Google"). Most regexes are word-boundary'd so
// "OpenAIRE" doesn't get matched as "OpenAI".
export const INDUSTRY_ORGS: OrgDef[] = [
  // — Frontier labs —
  { canonical: "OpenAI",            match: /\bopen\s*ai\b/i },
  { canonical: "Anthropic",         match: /\banthropic\b/i },
  { canonical: "Google DeepMind",   match: /\b(google\s*deepmind|deepmind)\b/i },
  { canonical: "Google Research",   match: /\bgoogle\s+(research|brain|cloud\s+ai)\b/i },
  { canonical: "Meta AI / FAIR",    match: /\b(meta\s+ai|facebook\s+ai|fair(\s|,|\.|$)|fundamental\s+ai\s+research)\b/i },
  { canonical: "Microsoft Research", match: /\b(microsoft\s+research|msra|msr\b)/i },
  { canonical: "Apple ML",          match: /\bapple\s+(ml|machine\s+learning|intelligence|aiml)\b/i },
  { canonical: "NVIDIA Research",   match: /\bnvidia\s+(research|ai|labs)\b/i },
  { canonical: "Mistral",           match: /\bmistral\s*(ai)?\b/i },
  { canonical: "Cohere",            match: /\bcohere\b/i },
  { canonical: "Stability AI",      match: /\bstability\s*ai\b/i },
  { canonical: "Inflection",        match: /\binflection\s+ai\b/i },
  { canonical: "Adept",             match: /\badept\s+ai\b/i },
  { canonical: "xAI",               match: /\bx\.?ai\b/i },
  { canonical: "Hugging Face",      match: /\bhugging\s*face\b/i },
  { canonical: "AI2 / Allen Institute", match: /\b(allen\s+institute|ai2)\b/i },
  { canonical: "Salesforce Research", match: /\bsalesforce\s+(research|ai)\b/i },
  { canonical: "IBM Research",      match: /\bibm\s+research\b/i },
  // — China frontier labs —
  { canonical: "DeepSeek",          match: /\bdeepseek\b/i },
  { canonical: "Moonshot",          match: /\bmoonshot\s*ai\b/i },
  { canonical: "Zhipu / GLM",       match: /\b(zhipu|智谱)\b/i },
  { canonical: "01.AI",             match: /\b01\.?ai\b/i },
  { canonical: "MiniMax",           match: /\bminimax\s*(ai)?\b/i },
  { canonical: "Baichuan",          match: /\b(baichuan|百川)\b/i },
  { canonical: "Qwen / Alibaba DAMO", match: /\b(qwen|alibaba\s+(damo|cloud|tongyi)|tongyi\s*qianwen)\b/i },
  { canonical: "ByteDance / Doubao", match: /\b(bytedance\s+(seed|research|ai)|doubao|豆包)\b/i },
  { canonical: "Tencent AI Lab",    match: /\btencent\s+(ai\s+lab|youtu|hunyuan)\b/i },
  { canonical: "Baidu",             match: /\bbaidu\s+(research|ernie)\b/i },
  // — Compute / infra —
  { canonical: "Anyscale",          match: /\banyscale\b/i },
  { canonical: "Databricks",        match: /\bdatabricks\b/i },
  { canonical: "Snowflake AI",      match: /\bsnowflake\s+(ai|research)\b/i },
  { canonical: "Together AI",       match: /\btogether\s*ai\b/i },
  { canonical: "Modal",             match: /\bmodal\s+labs\b/i },
  // — Robotics / specialized —
  { canonical: "Tesla AI",          match: /\btesla\s+(ai|autopilot|optimus)\b/i },
  { canonical: "Waymo",             match: /\bwaymo\b/i },
  { canonical: "Physical Intelligence", match: /\bphysical\s+intelligence\b/i },
  { canonical: "Skild AI",          match: /\bskild\s+ai\b/i },
];

const INTERN_PHRASES = [
  /work(\s+was\s+done|\s+done|\s+performed|ed)?\s+(during|while)\s+(an?\s+)?(internship|interning|residency|visit(ing)?|fellowship)\s+(at\s+|with\s+)/i,
  /while\s+(?:at|interning\s+at|visiting)\s+/i,
  /during\s+(?:an?\s+)?internship\s+at\s+/i,
  /(?:currently|now)\s+(?:at|with)\s+/i,
  /research\s+intern(ship)?\s+at\s+/i,
];

/** Detect orgs from a free-text blob (S2 affiliation string OR ack section). */
export function detectOrgs(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const def of INDUSTRY_ORGS) {
    if (def.match.test(text)) found.add(def.canonical);
  }
  return Array.from(found);
}

/** Sharper detection for ack/footnote text. Looks for "intern at X" /
 *  "while at X" patterns first, then falls back to plain mention. The
 *  ack-context match is more reliable signal than a generic mention
 *  ("we thank Google for support" vs "while interning at Google"). */
export function detectOrgsFromAck(text: string | null | undefined): { orgs: string[]; strongMatch: boolean } {
  if (!text) return { orgs: [], strongMatch: false };

  // Search for intern-phrase context first
  const slices: string[] = [];
  for (const phrase of INTERN_PHRASES) {
    const m = text.match(new RegExp(phrase.source + "(.{0,120})", phrase.flags));
    if (m) slices.push(m[0]);
  }

  if (slices.length > 0) {
    const found = new Set<string>();
    for (const s of slices) {
      for (const def of INDUSTRY_ORGS) if (def.match.test(s)) found.add(def.canonical);
    }
    if (found.size > 0) return { orgs: Array.from(found), strongMatch: true };
  }

  // Fall back to plain mention anywhere in the text
  const orgs = detectOrgs(text);
  return { orgs, strongMatch: false };
}
