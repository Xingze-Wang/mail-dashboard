import type { ReactNode } from "react";

// Standard app vocabulary now applies — analysis pages render inside the
// regular .app-content shell with mint background + 32/40/48 padding.
// Insights/cuts use section-card / page-title patterns to match Overview.
export default function AnalysisLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
