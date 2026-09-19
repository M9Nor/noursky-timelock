import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import TopBar from "./TopBar.jsx";

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
});
