import type { ReactNode } from "react";
import { CongressNav } from "./CongressNav";

export default function CongressLayout({ children }: { children: ReactNode }) {
  // Standard app vocabulary by default. The timeline page does its own
  // edge-to-edge cream background; every other tab inherits app-content's
  // mint background + padding for visual consistency with /, /pipeline,
  // /emails, etc.
  //
  // The nav strip is rendered at the top of every congress tab and uses
  // the normal page-title scale.
  return (
    <div>
      <CongressNav />
      <div>{children}</div>
    </div>
  );
}
