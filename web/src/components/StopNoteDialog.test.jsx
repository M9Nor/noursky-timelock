import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import StopNoteDialog from "./StopNoteDialog.jsx";

describe("StopNoteDialog", () => {
  it("blocks an empty note when the note is required", () => {
    const onConfirm = vi.fn();
    render(<StopNoteDialog required onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("الملاحظة مطلوبة لإنهاء الدوام")).toBeInTheDocument();
  });

  it("allows an empty note when it is optional and trims what is typed", () => {
    const onConfirm = vi.fn();
    const { unmount } = render(<StopNoteDialog required={false} onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    expect(onConfirm).toHaveBeenLastCalledWith("");
    unmount();
    render(<StopNoteDialog required={false} onConfirm={onConfirm} onCancel={() => {}} />);
    fireEvent.change(screen.getByLabelText("ملاحظة"), { target: { value: "  أنهيت العرض  " } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    expect(onConfirm).toHaveBeenLastCalledWith("أنهيت العرض");
  });
});
