import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import SessionEditModal from "./SessionEditModal.jsx";

describe("SessionEditModal", () => {
  const base = { id: "s1", started_at: 1000, ended_at: 4600 };
  it("blocks save without a reason", () => {
    const api = { patch: vi.fn() };
    render(<SessionEditModal api={api} session={base} onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    expect(screen.getByText(/سبب التعديل مطلوب/)).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });
  it("PATCHes with reason and calls onSaved", async () => {
    const api = { patch: vi.fn().mockResolvedValue({}) };
    const onSaved = vi.fn();
    render(<SessionEditModal api={api} session={base} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText(/سبب/), { target: { value: "نسي يسجل" } });
    fireEvent.click(screen.getByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalled());
    const [path, body] = api.patch.mock.calls[0];
    expect(path).toBe("/admin/sessions/s1");
    expect(body.reason).toBe("نسي يسجل");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
