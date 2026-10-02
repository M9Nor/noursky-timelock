import { useEffect } from "react";

const MARK = "⚠️ ";
const strip = (t) => (t.startsWith(MARK) ? t.slice(MARK.length) : t);

/** Prefixes the tab title with ⚠️ while `active` (spec §12.4) and restores it afterwards. */
export function useAlertTitle(active) {
  useEffect(() => {
    if (!active) return undefined;
    document.title = MARK + strip(document.title);
    return () => { document.title = strip(document.title); };
  }, [active]);
}
