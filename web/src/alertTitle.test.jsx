import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useAlertTitle } from "./alertTitle.js";

function Probe({ active }) { useAlertTitle(active); return null; }

describe("useAlertTitle", () => {
  it("prefixes the title with ⚠️ while active and restores it after", () => {
    document.title = "الدوام";
    const { rerender, unmount } = render(<Probe active />);
    expect(document.title).toBe("⚠️ الدوام");
    rerender(<Probe active={false} />);
    expect(document.title).toBe("الدوام");
    rerender(<Probe active />);
    unmount();
    expect(document.title).toBe("الدوام");
  });
});
