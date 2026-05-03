export function ArchitectureDiagram() {
  return (
    <svg viewBox="0 0 680 416" role="img" className="w-full" aria-labelledby="arch-title arch-desc">
      <title id="arch-title">Four-loop congress architecture by cadence</title>
      <desc id="arch-desc">
        Three primary loops stacked by cadence — daily apprentice, weekly tactical congress, monthly strategic congress —
        with monthly directives flowing back to the weekly loop, and a conditional quarterly postmortem on the right.
      </desc>
      <defs>
        <marker id="arch-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      <g>
        <rect x={80} y={40} width={320} height={76} rx={8} strokeWidth={0.5} className="fill-sky-50 stroke-sky-700 dark:fill-sky-950 dark:stroke-sky-300" />
        <text x={240} y={68} textAnchor="middle" dominantBaseline="central" className="fill-sky-900 dark:fill-sky-100 text-sm font-medium">Daily — Apprentice</text>
        <text x={240} y={92} textAnchor="middle" dominantBaseline="central" className="fill-sky-700 dark:fill-sky-200 text-xs">1 agent · drift detection (JITR)</text>
      </g>
      <line x1={240} y1={116} x2={240} y2={166} strokeWidth={1.5} markerEnd="url(#arch-arrow)" className="stroke-zinc-500 dark:stroke-zinc-400" />

      <g>
        <rect x={80} y={170} width={320} height={76} rx={8} strokeWidth={0.5} className="fill-sky-50 stroke-sky-700 dark:fill-sky-950 dark:stroke-sky-300" />
        <text x={240} y={198} textAnchor="middle" dominantBaseline="central" className="fill-sky-900 dark:fill-sky-100 text-sm font-medium">Weekly — Tactical congress</text>
        <text x={240} y={222} textAnchor="middle" dominantBaseline="central" className="fill-sky-700 dark:fill-sky-200 text-xs">6 personas · ship 1–3</text>
      </g>
      <line x1={240} y1={246} x2={240} y2={296} strokeWidth={1.5} markerEnd="url(#arch-arrow)" className="stroke-zinc-500 dark:stroke-zinc-400" />

      <g>
        <rect x={80} y={300} width={320} height={76} rx={8} strokeWidth={0.5} className="fill-sky-50 stroke-sky-700 dark:fill-sky-950 dark:stroke-sky-300" />
        <text x={240} y={328} textAnchor="middle" dominantBaseline="central" className="fill-sky-900 dark:fill-sky-100 text-sm font-medium">Monthly — Strategic congress</text>
        <text x={240} y={352} textAnchor="middle" dominantBaseline="central" className="fill-sky-700 dark:fill-sky-200 text-xs">5 agents · grade and rethink</text>
      </g>

      <path d="M 80 338 L 50 338 L 50 208 L 80 208" fill="none" strokeWidth={1.5} markerEnd="url(#arch-arrow)" className="stroke-zinc-500 dark:stroke-zinc-400" />

      <g>
        <rect x={440} y={170} width={180} height={76} rx={8} strokeWidth={0.5} strokeDasharray="4 3" className="fill-orange-50 stroke-orange-700 dark:fill-orange-950 dark:stroke-orange-300" />
        <text x={530} y={198} textAnchor="middle" dominantBaseline="central" className="fill-orange-900 dark:fill-orange-100 text-sm font-medium">Postmortem</text>
        <text x={530} y={222} textAnchor="middle" dominantBaseline="central" className="fill-orange-700 dark:fill-orange-200 text-xs">Quarterly · 3 agents</text>
      </g>
      <line x1={440} y1={208} x2={400} y2={208} strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arch-arrow)" className="stroke-zinc-500 dark:stroke-zinc-400" />
    </svg>
  );
}
