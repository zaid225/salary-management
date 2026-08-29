import * as React from "react";

/**
 * Seconds elapsed since `active` became true, ticking every 250ms. Resets
 * whenever `active` flips back on. Used anywhere a request has no
 * meaningful percent-complete to report (a single LLM call, a single import
 * request) — elapsed time is the one honest thing to show instead of a
 * fake percentage.
 */
export function useElapsedSeconds(active: boolean): number {
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(id);
  }, [active]);
  return elapsed;
}
