import { describe, it, expect, vi } from "vitest";
import { devLogin, getGhlSso } from "./auth.js";

describe("auth", () => {
  it("devLogin posts role and returns token+user", async () => {
    const api = { post: vi.fn().mockResolvedValue({ token: "T", user: { role: "manager" } }) };
    const r = await devLogin(api, "manager");
    expect(api.post).toHaveBeenCalledWith("/auth/dev-login", { role: "manager" });
    expect(r).toEqual({ token: "T", user: { role: "manager" } });
  });

  it("getGhlSso rejects on timeout", async () => {
    vi.useFakeTimers();
    const p = getGhlSso(10);
    vi.advanceTimersByTime(11);
    await expect(p).rejects.toThrow("SSO_TIMEOUT");
    vi.useRealTimers();
  });

  it("getGhlSso resolves with payload from postMessage", async () => {
    const p = getGhlSso(5000);
    window.dispatchEvent(new MessageEvent("message", {
      data: { message: "REQUEST_USER_DATA_RESPONSE", payload: "ENC" },
    }));
    await expect(p).resolves.toBe("ENC");
  });
});
