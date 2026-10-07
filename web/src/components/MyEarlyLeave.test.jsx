import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MyEarlyLeave from "./MyEarlyLeave.jsx";

const at = Date.UTC(2026, 9, 7, 12, 0) / 1000;

describe("MyEarlyLeave", () => {
  it("renders nothing without requests", async () => {
    const api = { get: vi.fn(async () => ({ requests: [], timezone: "UTC" })) };
    const { container } = render(<MyEarlyLeave api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/me/early-leave?days=30"));
    expect(container.querySelector(".my-early-leave")).toBeNull();
  });

  it("lists each request with status, reason and the answer", async () => {
    const api = { get: vi.fn(async () => ({ timezone: "UTC", requests: [
      { id: "r1", reason: "موعد", requested_at: at, status: "rejected", decided_at: at + 600, decided_by_name: "سارة", manager_note: "بكرا" },
    ] })) };
    render(<MyEarlyLeave api={api} />);
    expect(await screen.findByText("موعد")).toBeInTheDocument();
    expect(screen.getByText("مرفوض")).toBeInTheDocument();
    expect(screen.getByText("سارة · 12:10")).toBeInTheDocument();
    expect(screen.getByText("بكرا")).toBeInTheDocument();
  });

  it("reloads when its reload key changes", async () => {
    const api = { get: vi.fn(async () => ({ requests: [], timezone: "UTC" })) };
    const { rerender } = render(<MyEarlyLeave api={api} reloadKey={0} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    rerender(<MyEarlyLeave api={api} reloadKey={1} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });
});
