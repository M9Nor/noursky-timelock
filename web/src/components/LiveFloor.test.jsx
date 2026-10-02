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

  it("marks an employee who is on a break", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 3600, break_started_at: now - 300 }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText(/استراحة/)).toBeInTheDocument();
    expect(screen.getByText("داخل الدوام").closest(".lane").textContent).toContain("أحمد");
  });

  it("marks working people during today's fixed window", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now,
      fixed_break: { starts_at: now - 60, ends_at: now + 3540, paid: false },
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 3600, break_started_at: null }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("وقت الاستراحة")).toBeInTheDocument();
  });

  it("flags a working employee idle past the threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now, idle_minutes: 30,
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 7200, idle_sec: 45 * 60 }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("بدون نشاط 45 د")).toBeInTheDocument();
  });

  it("does not flag idle time under the threshold", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now, idle_minutes: 30,
      employees: [{ user_id: "a", name: "أحمد", session_id: "s1", started_at: now - 7200, idle_sec: 10 * 60 }],
    })) };
    render(<LiveFloor api={api} />);
    await screen.findByText("أحمد");
    expect(screen.queryByText(/بدون نشاط/)).not.toBeInTheDocument();
  });

  it("marks an offline employee who is active without a session", async () => {
    const now = Math.floor(Date.now() / 1000);
    const api = { get: vi.fn(async () => ({
      server_time: now, idle_minutes: 30,
      employees: [{ user_id: "b", name: "سارة", session_id: null, started_at: null, active_without_session: true }],
    })) };
    render(<LiveFloor api={api} />);
    expect(await screen.findByText("نشِط بدون دوام")).toBeInTheDocument();
    expect(screen.getByText("غير متصل").closest(".lane").textContent).toContain("سارة");
  });
});
