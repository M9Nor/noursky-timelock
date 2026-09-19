import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ToastProvider } from "./ToastContext.jsx";
import SettingsPanel from "./SettingsPanel.jsx";

const wrap = (ui) => render(<ToastProvider>{ui}</ToastProvider>);

describe("SettingsPanel", () => {
  it("loads settings then saves via PUT", async () => {
    const api = {
      get: vi.fn(async () => ({ timezone: "Asia/Riyadh", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00" })),
      put: vi.fn(async () => ({ timezone: "Asia/Dubai", daily_target_hours: 8, max_session_hours: 12, work_start: "09:00" })),
    };
    wrap(<SettingsPanel api={api} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/admin/settings"));
    fireEvent.click(await screen.findByRole("button", { name: /حفظ/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/admin/settings", expect.objectContaining({ timezone: "Asia/Riyadh" })));
  });
});
