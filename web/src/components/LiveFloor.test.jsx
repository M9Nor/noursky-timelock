import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LiveFloor from "./LiveFloor.jsx";

describe("LiveFloor", () => {
  it("splits working and offline employees", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      employees: [
        { user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 120 },
        { user_id: "b", name: "سارة", session_id: null, started_at: null },
      ],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("سارة")).toBeInTheDocument();
    // one working lane entry
    expect(screen.getByText("داخل الدوام").closest(".lane").textContent).toContain("أحمد");
    expect(screen.getByText("غير متصل").closest(".lane").textContent).toContain("سارة");
  });
});
