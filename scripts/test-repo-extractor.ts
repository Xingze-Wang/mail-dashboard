// Verify HF / GitHub repo extraction. Run: `npx tsx scripts/test-repo-extractor.ts`.
// Specifically guards against regression of the `huggingface.co/v1/production`
// false positive that the old optional-prefix regex produced.
// Reference: SMOKE_TEST_REPORT_2026-05-09.md finding #11.

import { extractFromText } from "../src/lib/repo-extractor";

const cases = [
  // [label, abstract text, expected hf, expected gh]
  [
    "models prefix",
    "Weights at https://huggingface.co/models/foo/bar.",
    "foo/bar",
    null,
  ],
  [
    "datasets prefix",
    "Released at huggingface.co/datasets/acme/dset",
    "acme/dset",
    null,
  ],
  [
    "spaces prefix",
    "Demo at huggingface.co/spaces/team/app",
    "team/app",
    null,
  ],
  [
    "no prefix is now ignored (bare host) — would have caused FP",
    "See huggingface.co/v1/production for endpoint docs.",
    null,
    null,
  ],
  [
    "papers/<id> URL is NOT a repo (regression guard)",
    "Indexed at https://huggingface.co/papers/2402.12345.",
    null,
    null,
  ],
  [
    "blog URL is NOT a repo (regression guard)",
    "Blog: https://huggingface.co/blog/awesome-thing.",
    null,
    null,
  ],
  [
    "github plain",
    "Code at https://github.com/foo/bar.",
    null,
    "foo/bar",
  ],
  [
    "both hf model + github",
    "Code: github.com/team/proj. Weights: huggingface.co/models/team/proj.",
    "team/proj",
    "team/proj",
  ],
  [
    "anonymous github filtered",
    "github.com/anonymous/sub-repo (review).",
    null,
    null,
  ],
  [
    "trailing punctuation stripped",
    "see huggingface.co/spaces/me/app),",
    "me/app",
    null,
  ],
];

let pass = 0;
let fail = 0;
for (const [label, text, expHf, expGh] of cases) {
  const out = extractFromText(text);
  const ok = out.hf_repo === expHf && out.github_repo === expGh;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}\n        hf=${JSON.stringify(out.hf_repo)} (expected ${JSON.stringify(expHf)})\n        gh=${JSON.stringify(out.github_repo)} (expected ${JSON.stringify(expGh)})`,
  );
  if (ok) pass++;
  else fail++;
}

console.log(`\n${pass}/${pass + fail} passing`);
process.exit(fail === 0 ? 0 : 1);
