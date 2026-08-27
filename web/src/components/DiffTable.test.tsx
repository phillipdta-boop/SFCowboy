// web/src/components/DiffTable.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DiffTable, diffItemKey } from "./DiffTable.js";

describe("DiffTable", () => {
  it("renders one flat table with Name, Type, Parent, Modified By, Modified Date, Select, and Status columns", () => {
    render(
      <DiffTable
        items={[
          { type: "ApexClass", fullName: "MyClass", status: "added", lastModifiedByName: "Ada", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
          { type: "CustomField", fullName: "Account.MyField__c", status: "modified" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    expect(screen.getByRole("columnheader", { name: /name/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /^type/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /parent/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /modified by/i })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /modified date/i })).toBeInTheDocument();
  });

  it("splits a dotted fullName into Parent and Name, leaving Parent blank when there's no dot", () => {
    render(
      <DiffTable
        items={[
          { type: "ApexClass", fullName: "MyClass", status: "added" },
          { type: "CustomField", fullName: "Account.MyField__c", status: "modified" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    const myClassRow = screen.getByText("MyClass").closest("tr") as HTMLElement;
    expect(within(myClassRow).getAllByRole("cell")[2]).toHaveTextContent("");

    const fieldRow = screen.getByText("MyField__c").closest("tr") as HTMLElement;
    expect(within(fieldRow).getByText("Account")).toBeInTheDocument();
  });

  it("shows each component's status as a labeled badge: New, Modified, Removed, Unchanged", () => {
    render(
      <DiffTable
        items={[
          { type: "ApexClass", fullName: "Added", status: "added" },
          { type: "ApexClass", fullName: "Changed", status: "modified" },
          { type: "ApexClass", fullName: "Gone", status: "removed" },
          { type: "ApexClass", fullName: "Same", status: "unchanged" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("Modified")).toBeInTheDocument();
    expect(screen.getByText("Removed")).toBeInTheDocument();
    expect(screen.getByText("Unchanged")).toBeInTheDocument();
  });

  it("calls onToggle with the item's key when its row checkbox is clicked", () => {
    const onToggle = vi.fn();
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "MyClass", status: "modified" }]}
        selected={new Set()}
        onToggle={onToggle}
      />
    );
    fireEvent.click(screen.getByRole("checkbox", { name: /MyClass/i }));
    expect(onToggle).toHaveBeenCalledWith("ApexClass::MyClass");
  });

  it("disables the checkbox for unchanged components", () => {
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "Same", status: "unchanged" }]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    expect(screen.getByRole("checkbox", { name: /Same/i })).toBeDisabled();
  });

  it("shows a Remove button instead of a checkbox when mode is 'remove'", () => {
    const onToggle = vi.fn();
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "MyClass", status: "added" }]}
        selected={new Set([diffItemKey({ type: "ApexClass", fullName: "MyClass" })])}
        onToggle={onToggle}
        mode="remove"
      />
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove myclass/i }));
    expect(onToggle).toHaveBeenCalledWith("ApexClass::MyClass");
  });

  it("sorts rows by Name ascending, then descending, when the Name header is clicked", () => {
    render(
      <DiffTable
        items={[
          { type: "ApexClass", fullName: "Zebra", status: "added" },
          { type: "ApexClass", fullName: "Apple", status: "added" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    fireEvent.click(within(screen.getByRole("columnheader", { name: /name/i })).getByRole("button"));
    let names = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Apple", "Zebra"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: /name/i })).getByRole("button"));
    names = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Zebra", "Apple"]);
  });

  it("sorts by Type ascending by default", () => {
    render(
      <DiffTable
        items={[
          { type: "Flow", fullName: "A", status: "added" },
          { type: "ApexClass", fullName: "B", status: "added" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    const types = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[1].textContent);
    expect(types).toEqual(["ApexClass", "Flow"]);
  });

  it("reverses to Type descending when the already-sorted Type header is clicked", () => {
    render(
      <DiffTable
        items={[
          { type: "Flow", fullName: "A", status: "added" },
          { type: "ApexClass", fullName: "B", status: "added" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    fireEvent.click(within(screen.getByRole("columnheader", { name: /^type/i })).getByRole("button"));
    const types = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[1].textContent);
    expect(types).toEqual(["Flow", "ApexClass"]);
  });

  it("sorts rows by Modified Date when its header is clicked", () => {
    render(
      <DiffTable
        items={[
          { type: "ApexClass", fullName: "A", status: "added", lastModifiedDate: "2026-03-01T00:00:00.000Z" },
          { type: "ApexClass", fullName: "B", status: "added", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    fireEvent.click(within(screen.getByRole("columnheader", { name: /modified date/i })).getByRole("button"));
    const names = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["B", "A"]);
  });

  it("sorts rows by Status when its header is clicked", () => {
    render(
      <DiffTable
        items={[
          { type: "ApexClass", fullName: "A", status: "removed" },
          { type: "ApexClass", fullName: "B", status: "added" },
          { type: "ApexClass", fullName: "C", status: "modified" },
        ]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    fireEvent.click(within(screen.getByRole("columnheader", { name: /^status/i })).getByRole("button"));
    const names = screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent);
    // Sorted by the displayed label: Modified, New, Removed
    expect(names).toEqual(["C", "B", "A"]);
  });
});
