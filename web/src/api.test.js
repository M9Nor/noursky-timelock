import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApi, ApiError } from "./api.js";

describe("api client", () => {
  beforeEach(() => { global.fetch = vi.fn(); });

  it("attaches bearer token and parses JSON", async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ x: 1 }) });
    const api = createApi(() => "TOK");
    const r = await api.get("/me/status");
    expect(r).toEqual({ x: 1 });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer TOK");
  });

  it("throws ApiError with code on non-ok", async () => {
    global.fetch.mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "SESSION_ALREADY_OPEN" }) });
    const api = createApi(() => "TOK");
    await expect(api.post("/session/start")).rejects.toMatchObject({ status: 409, code: "SESSION_ALREADY_OPEN" });
  });

  it("omits Authorization when no token", async () => {
    global.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const api = createApi(() => null);
    await api.post("/auth/dev-login", { role: "manager" });
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });
});
