import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import LivePanel from "./LivePanel.jsx";

describe("LivePanel", () => {
  it("marks open sessions as working and closed as offline", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      employees: [
        { user_id: "a", name: "أحمد", started_at: now - 120, session_id: "s1" },
        { user_id: "b", name: "سارة", started_at: null, session_id: null },
      ],
    })) };
    render(<LivePanel api={api} />);
    expect(await screen.findByText("أحمد")).toBeInTheDocument();
    expect(await screen.findByText("سارة")).toBeInTheDocument();
    expect(screen.getAllByText(/شغّال الآن/).length).toBe(1);
  });
});
