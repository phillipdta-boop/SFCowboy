import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Modal } from "./Modal.js";

describe("Modal", () => {
  it("renders its title and children", () => {
    render(
      <Modal title="Export Components" onClose={() => {}}>
        <p>Hello</p>
      </Modal>
    );
    expect(screen.getByRole("dialog", { name: "Export Components" })).toBeInTheDocument();
    expect(screen.getByText("Hello")).toBeInTheDocument();
  });

  it("calls onClose when the backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Export Components" onClose={onClose}>
        <p>Hello</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  it("does not call onClose when the dialog content itself is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Export Components" onClose={onClose}>
        <p>Hello</p>
      </Modal>
    );
    fireEvent.click(screen.getByText("Hello"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose when the close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Export Components" onClose={onClose}>
        <p>Hello</p>
      </Modal>
    );
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal title="Export Components" onClose={onClose}>
        <p>Hello</p>
      </Modal>
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
