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

  it("moves focus into the note field on open", () => {
    render(<StopNoteDialog required={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText("ملاحظة")).toHaveFocus();
  });

  it("closes on Escape", () => {
    const onCancel = vi.fn();
    render(<StopNoteDialog required={false} onConfirm={() => {}} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });

  it("shows an external error (e.g. a failed stop) in the same error span", () => {
    render(<StopNoteDialog required={false} error="حدث خطأ، حاول مرة أخرى" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText("حدث خطأ، حاول مرة أخرى")).toBeInTheDocument();
  });

  it("disables the Cancel button while loading", () => {
    const onCancel = vi.fn();
    render(<StopNoteDialog required={false} loading onConfirm={() => {}} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "إلغاء" })).toBeDisabled();
  });

  it("links the required-note error to the textarea via aria-describedby", () => {
    render(<StopNoteDialog required onConfirm={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "تأكيد الإنهاء" }));
    const textarea = screen.getByLabelText("ملاحظة");
    const describedBy = textarea.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy).textContent).toBe("الملاحظة مطلوبة لإنهاء الدوام");
  });
});
