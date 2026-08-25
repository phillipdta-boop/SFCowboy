// web/src/components/DiffTree.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiffTree, diffItemKey } from "./DiffTree.js";

describe("DiffTree", () => {
  it("groups components by metadata type and shows their status", () => {
    render(
      <DiffTree
        items={[
          { type: "ApexClass", fullName: "MyClass", status: "modified" },
          { type: "CustomObject", fullName: "Account", status: "added" },
        ]}
        selected={new Set([diffItemKey({ type: "ApexClass", fullName: "MyClass" })])}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("ApexClass")).toBeInTheDocument();
    expect(screen.getByText(/MyClass \(modified\)/)).toBeInTheDocument();
    expect(screen.getByText(/Account \(added\)/)).toBeInTheDocument();
  });

  it("calls onToggle with the item's key when its checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(
      <DiffTree
        items={[{ type: "ApexClass", fullName: "MyClass", status: "modified" }]}
        selected={new Set()}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByLabelText(/MyClass/));
    expect(onToggle).toHaveBeenCalledWith("ApexClass::MyClass");
  });
});
