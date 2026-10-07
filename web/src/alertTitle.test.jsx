import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useAlertTitle } from "./alertTitle.js";

function Mark({ on }) { useAlertTitle(on); return null; }

describe("useAlertTitle", () => {
  it("keeps the mark while any of two panels still needs it", () => {
    document.title = "TimeClock";
    const a = render(<Mark on />);
    const b = render(<Mark on />);
    expect(document.title).toBe("⚠️ TimeClock");
    a.unmount();
    expect(document.title).toBe("⚠️ TimeClock");
    b.unmount();
    expect(document.title).toBe("TimeClock");
  });
});
