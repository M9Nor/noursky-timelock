import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { I18nProvider, useI18n, translate } from "./i18n.jsx";
import ar from "./locales/ar.js";
import en from "./locales/en.js";

const ARABIC = /[؀-ۿ]/;
// Each language's own name is written in that language in both dictionaries.
const NATIVE_NAMES = new Set(["lang.switch", "settings.langAr"]);
// Paths are relative to src/ and resolved from the web/ working directory (vitest runs there; import.meta.url is not a file: URL under jsdom).
// Files whose user-visible text must come only from the dictionaries. Tasks 3–4 add theirs.
const TRANSLATED_FILES = ["App.jsx", "components/TopBar.jsx"];

describe("dictionaries", () => {
  it("have the same keys", () => { expect(Object.keys(en).sort()).toEqual(Object.keys(ar).sort()); });
  it("keep English free of Arabic letters", () => {
    expect(Object.entries(en).filter(([k, v]) => !NATIVE_NAMES.has(k) && ARABIC.test(v))).toEqual([]);
  });
  it("leave no Arabic text in translated files", () => {
    const offenders = TRANSLATED_FILES.filter((f) => ARABIC.test(readFileSync(resolve(process.cwd(), "src", f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("translate", () => {
  it("fills {placeholders} and falls back to Arabic, then to the key", () => {
    expect(translate("en", "test.hello", { name: "Sara" })).toBe("Hello, Sara");
    expect(translate("ar", "test.hello", { name: "سارة" })).toBe("مرحباً، سارة");
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });
});

function Probe() {
  const { locale, t, setLocale } = useI18n();
  return <button onClick={() => setLocale(locale === "ar" ? "en" : "ar")}>{t("test.hello", { name: "x" })}</button>;
}

describe("I18nProvider", () => {
  it("defaults to Arabic without a provider", () => {
    render(<Probe />);
    expect(screen.getByRole("button")).toHaveTextContent("مرحباً، x");
  });
  it("switches language and direction and reports the change", () => {
    const changes = [];
    render(<I18nProvider locale="ar" onChange={(l) => changes.push(l)}><Probe /></I18nProvider>);
    expect(document.documentElement.dir).toBe("rtl");
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("Hello, x");
    expect(document.documentElement.dir).toBe("ltr");
    expect(document.documentElement.lang).toBe("en");
    expect(changes).toEqual(["en"]);
  });
});
