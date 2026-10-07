import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import EarlyLeaveDialog from "./EarlyLeaveDialog.jsx";

describe("EarlyLeaveDialog", () => {
  it("shows the work end and refuses an empty reason", () => {
    const onSend = vi.fn();
    render(<EarlyLeaveDialog workEnd="18:00" onSend={onSend} onCancel={() => {}} />);
    expect(screen.getByText(/18:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText("اكتب السبب")).toBeInTheDocument();
  });

  it("sends the trimmed reason", () => {
    const onSend = vi.fn();
    render(<EarlyLeaveDialog workEnd="18:00" onSend={onSend} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("السبب"), { target: { value: "  موعد  " } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الطلب" }));
    expect(onSend).toHaveBeenCalledWith("موعد");
  });
});
