import { createContext, useContext, useEffect, useMemo, useState } from "react";
import ar from "./locales/ar.js";
import en from "./locales/en.js";

const DICTS = { ar, en };
const TITLE_MARK = "⚠️ ";

/** Text for `key` in `locale`, {name} placeholders filled; falls back to Arabic, then to the key. */
export function translate(locale, key, vars) {
  const s = DICTS[locale]?.[key] ?? ar[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k]))) : s;
}

const I18nContext = createContext({ locale: "ar", t: (k, v) => translate("ar", k, v), setLocale: () => {} });

/** Provides the language; keeps <html lang/dir> and the tab title in step with it. */
export function I18nProvider({ locale, onChange, children }) {
  const [current, setCurrent] = useState(locale === "en" ? "en" : "ar");
  useEffect(() => { setCurrent(locale === "en" ? "en" : "ar"); }, [locale]);
  useEffect(() => {
    const el = document.documentElement;
    el.lang = current;
    el.dir = current === "ar" ? "rtl" : "ltr";
    const marked = document.title.startsWith(TITLE_MARK);
    document.title = (marked ? TITLE_MARK : "") + translate(current, "app.title");
  }, [current]);
  const value = useMemo(() => ({
    locale: current,
    t: (k, v) => translate(current, k, v),
    setLocale: (next) => {
      if (next !== "ar" && next !== "en") return;
      setCurrent(next);
      onChange?.(next);
    },
  }), [current, onChange]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
