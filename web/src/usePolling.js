import { useEffect, useRef } from "react";

// A visibility change and a focus usually arrive together when the user comes back to the
// tab; one re-read is enough for both.
const RETURN_GAP_MS = 2000;
/** Fired after an action that changes what other panels show (e.g. an approval ends a shift). */
export const REFRESH_EVENT = "timeclock:refresh";

/**
 * Re-runs `fn` every `ms`, and at once when the page becomes visible again or the window
 * gets focus. Browsers slow down or freeze timers in a background tab (and in the GHL
 * iframe inside it), so without the return trigger the screen stays stale for up to a
 * whole interval after the user comes back. REFRESH_EVENT re-runs it at once (no gap): another
 * panel changed something this one shows. The first load stays with the caller.
 * Errors are swallowed: a failed refresh keeps what is on screen.
 */
export function usePolling(fn, ms) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let last = 0;
    const run = () => {
      last = Date.now();
      try { Promise.resolve(fnRef.current()).catch(() => {}); } catch { /* keep the screen as is */ }
    };
    const onReturn = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - last < RETURN_GAP_MS) return;
      run();
    };
    const id = setInterval(run, ms);
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    window.addEventListener(REFRESH_EVENT, run);
    return () => {
      window.removeEventListener(REFRESH_EVENT, run);
      clearInterval(id);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [ms]);
}
