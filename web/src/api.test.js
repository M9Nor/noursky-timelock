import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

  describe("download", () => {
    let createObjectURL, revokeObjectURL, createElement;

    beforeEach(() => {
      createObjectURL = URL.createObjectURL;
      revokeObjectURL = URL.revokeObjectURL;
      URL.createObjectURL = vi.fn(() => "blob:mock");
      URL.revokeObjectURL = vi.fn();
      createElement = document.createElement.bind(document);
      vi.spyOn(document, "createElement");
    });

    afterEach(() => {
      URL.createObjectURL = createObjectURL;
      URL.revokeObjectURL = revokeObjectURL;
      document.createElement.mockRestore?.();
    });

    it("attaches bearer token and triggers a file download on success", async () => {
      const clickSpy = vi.fn();
      document.createElement.mockImplementation((tag) => {
        const el = createElement(tag);
        if (tag === "a") el.click = clickSpy;
        return el;
      });
      global.fetch.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(["x"]) });
      const api = createApi(() => "TOK");
      await api.download("/admin/export.csv?from=0&to=1", "timeclock-0-1.csv");
      const [path, opts] = global.fetch.mock.calls[0];
      expect(path).toBe("/admin/export.csv?from=0&to=1");
      expect(opts.headers.Authorization).toBe("Bearer TOK");
      expect(URL.createObjectURL).toHaveBeenCalled();
      expect(clickSpy).toHaveBeenCalled();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    });

    it("omits Authorization when no token", async () => {
      global.fetch.mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(["x"]) });
      const api = createApi(() => null);
      await api.download("/admin/export.csv?from=0&to=1", "f.csv");
      const [, opts] = global.fetch.mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });

    it("throws ApiError with code on non-ok", async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "UNAUTHORIZED" }) });
      const api = createApi(() => "TOK");
      await expect(api.download("/admin/export.csv?from=0&to=1", "f.csv")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    });
  });
});
