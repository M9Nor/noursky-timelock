import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import App from "./App.jsx";

describe("App", () => {
  beforeEach(() => { global.fetch = vi.fn(); });

  it("in dev shows role picker when no token", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /دخول كمدير/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /دخول كموظف/ })).toBeInTheDocument();
  });

  it("dev manager login routes to dashboard", async () => {
    global.fetch.mockImplementation(async (path) => {
      if (path === "/auth/dev-login") return { ok: true, status: 200, json: async () => ({ token: "T", user: { role: "manager", name: "مدير تجريبي" } }) };
      if (path.startsWith("/admin/live")) return { ok: true, status: 200, json: async () => ({ server_time: 1, employees: [] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /دخول كمدير/ }));
    expect(await screen.findByRole("heading", { name: /الفريق الآن/ })).toBeInTheDocument();
  });

  it("dev employee login routes to employee screen", async () => {
    global.fetch.mockImplementation(async (path) => {
      if (path === "/auth/dev-login") return { ok: true, status: 200, json: async () => ({ token: "T", user: { role: "employee", name: "موظف تجريبي" } }) };
      if (path.startsWith("/me/status")) return { ok: true, status: 200, json: async () => ({ open_session: null, worked_sec: 0, server_time: 1 }) };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /دخول كموظف/ }));
    expect(await screen.findByRole("button", { name: /بدء الدوام/ })).toBeInTheDocument();
  });
});
