import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Button from "./Button.jsx";

describe("Button", () => {
  it("applies variant and size classes", () => {
    render(<Button variant="danger" size="lg">إنهاء</Button>);
    const b = screen.getByRole("button", { name: "إنهاء" });
    expect(b.className).toContain("btn-danger");
    expect(b.className).toContain("btn-lg");
  });
  it("disables and shows ellipsis while loading", () => {
    render(<Button loading>ابدأ</Button>);
    const b = screen.getByRole("button");
    expect(b).toBeDisabled();
    expect(b.textContent).toBe("…");
  });
  it("calls onClick", () => {
    const fn = vi.fn();
    render(<Button onClick={fn}>ابدأ</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(fn).toHaveBeenCalled();
  });
});
