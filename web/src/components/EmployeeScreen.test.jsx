import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EmployeeScreen from "./EmployeeScreen.jsx";

function makeApi(statusSeq) {
  let i = 0;
  return {
    get: vi.fn(async () => statusSeq[Math.min(i++, statusSeq.length - 1)]),
    post: vi.fn(async () => ({})),
  };
}

describe("EmployeeScreen", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows start button when no open session", async () => {
    const api = makeApi([{ open_session: null, worked_sec: 0, server_time: 1000 }]);
    render(<EmployeeScreen api={api} />);
    expect(await screen.findByRole("button", { name: /ابدأ الدوام/ })).toBeInTheDocument();
  });

  it("shows stop button when a session is open", async () => {
    const started = Math.floor(Date.now() / 1000) - 60;
    const api = makeApi([{ open_session: { id: "s1", started_at: started }, worked_sec: 60, server_time: started + 60 }]);
    render(<EmployeeScreen api={api} />);
    expect(await screen.findByRole("button", { name: /إنهاء الدوام/ })).toBeInTheDocument();
  });

  it("calls /session/start when start clicked", async () => {
    const api = makeApi([{ open_session: null, worked_sec: 0, server_time: 1000 }]);
    render(<EmployeeScreen api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /ابدأ الدوام/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/session/start"));
  });
});
