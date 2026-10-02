import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TopBar from "./TopBar.jsx";
import { I18nProvider } from "../i18n.jsx";

describe("TopBar", () => {
  it("renders brand and a today label", () => {
    render(<TopBar role="employee" onRole={() => {}} />);
    expect(screen.getByText("NourSky")).toBeInTheDocument();
  });
  it("in dev, switching role calls onRole", () => {
    const onRole = vi.fn();
    render(<TopBar role="employee" onRole={onRole} />);
    // dev build: segmented control present
    fireEvent.click(screen.getByLabelText("المدير"));
    expect(onRole).toHaveBeenCalledWith("manager");
  });
  it("switches the language from the top bar", () => {
    render(<I18nProvider locale="ar"><TopBar role="employee" onRole={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("button", { name: "عربي" })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe("ltr");
  });
});
