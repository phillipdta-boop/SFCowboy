// web/src/components/MetadataTypeSelector.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MetadataTypeSelector } from "./MetadataTypeSelector.js";

describe("MetadataTypeSelector", () => {
  it("shows selected types as removable chips", () => {
    render(
      <MetadataTypeSelector
        types={["ApexClass", "Flow", "CustomObject"]}
        selected={new Set(["ApexClass"])}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onSelectNone={() => {}}
      />
    );
    expect(screen.getByText("ApexClass")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove apexclass/i })).toBeInTheDocument();
  });

  it("removes a chip's type when its remove button is clicked", () => {
    const onToggle = vi.fn();
    render(
      <MetadataTypeSelector
        types={["ApexClass", "Flow"]}
        selected={new Set(["ApexClass"])}
        onToggle={onToggle}
        onSelectAll={() => {}}
        onSelectNone={() => {}}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /remove apexclass/i }));
    expect(onToggle).toHaveBeenCalledWith("ApexClass");
  });

  it("opens a dropdown of unselected types when the combobox is focused", () => {
    render(
      <MetadataTypeSelector
        types={["ApexClass", "Flow", "CustomObject"]}
        selected={new Set(["ApexClass"])}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onSelectNone={() => {}}
      />
    );
    fireEvent.focus(screen.getByRole("combobox"));
    expect(screen.getByRole("option", { name: "Flow" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "CustomObject" })).toBeInTheDocument();
    // ApexClass is already selected, so it shouldn't be offered again in the dropdown.
    expect(screen.queryByRole("option", { name: "ApexClass" })).not.toBeInTheDocument();
  });

  it("filters dropdown options as the user types", () => {
    render(
      <MetadataTypeSelector
        types={["ApexClass", "Flow", "CustomObject"]}
        selected={new Set()}
        onToggle={() => {}}
        onSelectAll={() => {}}
        onSelectNone={() => {}}
      />
    );
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "flow" } });
    expect(screen.getByRole("option", { name: "Flow" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "ApexClass" })).not.toBeInTheDocument();
  });

  it("selects a type and clears the search text when a dropdown option is picked", () => {
    const onToggle = vi.fn();
    render(
      <MetadataTypeSelector
        types={["ApexClass", "Flow"]}
        selected={new Set()}
        onToggle={onToggle}
        onSelectAll={() => {}}
        onSelectNone={() => {}}
      />
    );
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "flow" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: "Flow" }));
    expect(onToggle).toHaveBeenCalledWith("Flow");
    expect(input.value).toBe("");
  });

  it("calls onSelectAll and onSelectNone from their buttons", () => {
    const onSelectAll = vi.fn();
    const onSelectNone = vi.fn();
    render(
      <MetadataTypeSelector
        types={["ApexClass"]}
        selected={new Set()}
        onToggle={() => {}}
        onSelectAll={onSelectAll}
        onSelectNone={onSelectNone}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: /select all/i }));
    fireEvent.click(screen.getByRole("button", { name: /select none/i }));
    expect(onSelectAll).toHaveBeenCalled();
    expect(onSelectNone).toHaveBeenCalled();
  });
});
