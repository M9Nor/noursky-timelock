import { useEffect } from "react";

const MARK = "⚠️ ";
const strip = (t) => (t.startsWith(MARK) ? t.slice(MARK.length) : t);
// Several panels can mark the title at once (activity alerts, early-leave requests): the mark
// stays until the last of them lets go.
let holders = 0;

/** Prefixes the tab title with ⚠️ while `active` (spec §12.4) and restores it afterwards. */
export function useAlertTitle(active) {
  useEffect(() => {
    if (!active) return undefined;
    holders += 1;
    document.title = MARK + strip(document.title);
    return () => {
      holders -= 1;
      if (holders === 0) document.title = strip(document.title);
    };
  }, [active]);
}
