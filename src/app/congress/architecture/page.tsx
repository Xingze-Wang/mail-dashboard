import { ArchitectureDiagram } from "@/components/congress/ArchitectureDiagram";

export default function CongressArchitecturePage() {
  return (
    <>
      <header className="mb-6 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div className="mb-1 text-xs text-zinc-500 dark:text-zinc-500">Congress · Architecture</div>
        <h1 className="text-lg font-medium">Four-loop council architecture</h1>
        <p className="mt-1 text-[13px] text-zinc-500 dark:text-zinc-400">
          Each loop answers a question the others can&apos;t. Daily detects, weekly debates, monthly grades and rethinks, quarterly does forensic postmortems when something breaks.
        </p>
      </header>

      <div className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        <ArchitectureDiagram />
      </div>

      <section className="mb-6">
        <h2 className="mb-2 text-base font-medium">Loops</h2>
        <ul className="space-y-3 text-[13px] text-zinc-700 dark:text-zinc-300">
          <li>
            <strong>Daily — Apprentice (JITR)</strong>: single agent watches reps&apos; edits to AI drafts, asks each rep individually
            &quot;want me to remember this for you?&quot; via Lark card. Per-rep templates only — never global.
          </li>
          <li>
            <strong>Weekly — Tactical congress</strong>: 6 personas argue about what to ship next (subject lines, template phrasing,
            routing). Synthesizer ranks 1–3; admin approves. Each shipped change carries an expected lift + evaluation deadline.
          </li>
          <li>
            <strong>Monthly — Strategic congress</strong>: 5 different personas grade last quarter&apos;s tactical decisions
            (Historian), look at the funnel as a whole (Funnel Economist), watch long-term emotional capital (Psychologist).
            Approved directives constrain the next 4 weekly congresses.
          </li>
          <li>
            <strong>Quarterly — Postmortem (conditional)</strong>: only fires when a metric breach is detected
            (overall conversion drops &gt;20%, a rep drops &gt;2σ for 3+ weeks). Output is narrative, not decisions —
            standing context for all loops until resolved.
          </li>
        </ul>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-base font-medium">How the loops connect</h2>
        <ul className="space-y-2 text-[13px] text-zinc-700 dark:text-zinc-300">
          <li>
            <strong>Daily → Weekly:</strong> if 3+ reps independently accept the same drift pattern, that&apos;s a Copywriter agenda item — should we lift it into the global template?
          </li>
          <li>
            <strong>Weekly → Monthly:</strong> every approved tactical change carries <code className="font-mono text-xs">expected_lift</code> + <code className="font-mono text-xs">weeks_to_evaluate</code>. The Historian receives the cohort whose evaluation window completed and grades hit/partial/miss/inconclusive.
          </li>
          <li>
            <strong>Monthly → Weekly:</strong> approved strategic directives become constraints on the next 4 weekly congresses (loaded into every persona&apos;s system prompt).
          </li>
          <li>
            <strong>Postmortem → all:</strong> while <code className="font-mono text-xs">resolved_at IS NULL</code>, the lesson is included in every loop&apos;s prompt as standing context.
          </li>
        </ul>
      </section>
    </>
  );
}
