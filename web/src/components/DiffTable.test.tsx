// web/src/components/DiffTable.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { DiffTable, diffItemKey } from "./DiffTable.js";

// Scoped to <tbody> so the header row and the per-column filter row never get counted as data.
function dataRows() {
  const table = screen.getByRole("table");
  return within(table.querySelector("tbody")!).queryAllByRole("row");
}

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
    let names = dataRows().map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["Apple", "Zebra"]);

    fireEvent.click(within(screen.getByRole("columnheader", { name: /name/i })).getByRole("button"));
    names = dataRows().map((r) => within(r).getAllByRole("cell")[0].textContent);
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
    const types = dataRows().map((r) => within(r).getAllByRole("cell")[1].textContent);
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
    const types = dataRows().map((r) => within(r).getAllByRole("cell")[1].textContent);
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
    const names = dataRows().map((r) => within(r).getAllByRole("cell")[0].textContent);
    expect(names).toEqual(["B", "A"]);
  });

  it("renders a fixed-layout table with a colgroup covering every column", () => {
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "MyClass", status: "added" }]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    const table = screen.getByRole("table");
    expect(table).toHaveClass("resizable-table");
    // Name, Type, Parent, Modified By, Modified Date, Select, Status
    expect(table.querySelectorAll("colgroup col")).toHaveLength(7);
  });

  it("redistributes width between two adjacent columns when the divider between them is dragged, without changing their combined width", () => {
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "MyClass", status: "added" }]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    const table = screen.getByRole("table");
    vi.spyOn(table, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const cols = table.querySelectorAll("colgroup col");
    const nameWidthBefore = parseFloat((cols[0] as HTMLElement).style.width);
    const typeWidthBefore = parseFloat((cols[1] as HTMLElement).style.width);

    const handle = screen.getByRole("columnheader", { name: /name/i }).querySelector(".col-resize-handle")!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 150 });

    const nameWidthAfter = parseFloat((cols[0] as HTMLElement).style.width);
    const typeWidthAfter = parseFloat((cols[1] as HTMLElement).style.width);

    expect(nameWidthAfter).toBeGreaterThan(nameWidthBefore);
    expect(typeWidthAfter).toBeLessThan(typeWidthBefore);
    expect(nameWidthAfter + typeWidthAfter).toBeCloseTo(nameWidthBefore + typeWidthBefore, 5);

    fireEvent.mouseUp(window);
  });

  it("does not shrink a column below its minimum width when dragged past it", () => {
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "MyClass", status: "added" }]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    const table = screen.getByRole("table");
    vi.spyOn(table, "getBoundingClientRect").mockReturnValue({ width: 1000 } as DOMRect);
    const cols = table.querySelectorAll("colgroup col");

    const handle = screen.getByRole("columnheader", { name: /name/i }).querySelector(".col-resize-handle")!;
    fireEvent.mouseDown(handle, { clientX: 100 });
    // Drag far enough left that Name would go negative without clamping.
    fireEvent.mouseMove(window, { clientX: -5000 });

    const nameWidthAfter = parseFloat((cols[0] as HTMLElement).style.width);
    const typeWidthAfter = parseFloat((cols[1] as HTMLElement).style.width);
    expect(nameWidthAfter).toBeGreaterThanOrEqual(6);
    expect(typeWidthAfter).toBeLessThanOrEqual(14 + 24 - 6);

    fireEvent.mouseUp(window);
  });

  it("does not render a resize handle after the last column", () => {
    render(
      <DiffTable
        items={[{ type: "ApexClass", fullName: "MyClass", status: "added" }]}
        selected={new Set()}
        onToggle={() => {}}
      />
    );
    const statusHeader = screen.getByRole("columnheader", { name: /^status/i });
    expect(statusHeader.querySelector(".col-resize-handle")).not.toBeInTheDocument();
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
    const names = dataRows().map((r) => within(r).getAllByRole("cell")[0].textContent);
    // Sorted by the displayed label: Modified, New, Removed
    expect(names).toEqual(["C", "B", "A"]);
  });

  describe("status filter", () => {
    const FOUR_STATUS_ITEMS = [
      { type: "ApexClass", fullName: "AddedOne", status: "added" as const },
      { type: "ApexClass", fullName: "ChangedOne", status: "modified" as const },
      { type: "ApexClass", fullName: "RemovedOne", status: "removed" as const },
      { type: "ApexClass", fullName: "SameOne", status: "unchanged" as const },
    ];

    it("shows every status by default and keeps the filter panel closed", () => {
      render(<DiffTable items={FOUR_STATUS_ITEMS} selected={new Set()} onToggle={() => {}} />);
      expect(dataRows()).toHaveLength(4);
      expect(screen.queryByRole("group", { name: /filter by status/i })).not.toBeInTheDocument();
    });

    it("opens the filter panel with a checkbox per status, all checked by default", () => {
      render(<DiffTable items={FOUR_STATUS_ITEMS} selected={new Set()} onToggle={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /^filter/i }));

      const panel = screen.getByRole("group", { name: /filter by status/i });
      for (const label of ["New", "Modified", "Removed", "Unchanged"]) {
        expect(within(panel).getByRole("checkbox", { name: label })).toBeChecked();
      }
    });

    it("hides rows whose status is unchecked in the filter", () => {
      render(<DiffTable items={FOUR_STATUS_ITEMS} selected={new Set()} onToggle={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
      const panel = screen.getByRole("group", { name: /filter by status/i });

      fireEvent.click(within(panel).getByRole("checkbox", { name: "New" }));

      expect(screen.queryByText("AddedOne")).not.toBeInTheDocument();
      expect(screen.getByText("ChangedOne")).toBeInTheDocument();
      expect(screen.getByText("RemovedOne")).toBeInTheDocument();
      expect(screen.getByText("SameOne")).toBeInTheDocument();
    });

    it("shows the active filter count in the toggle button once something is unchecked", () => {
      render(<DiffTable items={FOUR_STATUS_ITEMS} selected={new Set()} onToggle={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
      const panel = screen.getByRole("group", { name: /filter by status/i });

      fireEvent.click(within(panel).getByRole("checkbox", { name: "New" }));

      expect(screen.getByRole("button", { name: /filter \(3\/4\)/i })).toBeInTheDocument();
    });

    it("shows no rows when Select none is clicked, and all rows again after Select all", () => {
      render(<DiffTable items={FOUR_STATUS_ITEMS} selected={new Set()} onToggle={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /^filter/i }));

      fireEvent.click(screen.getByRole("button", { name: /select none/i }));
      expect(dataRows()).toHaveLength(0);

      fireEvent.click(screen.getByRole("button", { name: /select all/i }));
      expect(dataRows()).toHaveLength(4);
    });
  });

  describe("per-column search", () => {
    const ITEMS = [
      { type: "ApexClass", fullName: "AccountHandler", status: "added" as const, lastModifiedByName: "Ada" },
      { type: "ApexTrigger", fullName: "OpportunityTrigger", status: "modified" as const, lastModifiedByName: "Bob" },
      { type: "CustomField", fullName: "Account.MyField__c", status: "unchanged" as const, lastModifiedByName: "Ada" },
    ];

    it("shows every row until something is typed", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);
      expect(dataRows()).toHaveLength(3);
    });

    it("filters by Name, case-insensitively, as you type", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);

      fireEvent.change(screen.getByRole("textbox", { name: /filter by name/i }), { target: { value: "account" } });

      // Only the Name column is matched — "Account.MyField__c" has Name "MyField__c" (Parent
      // "Account" is a separate column), so it does NOT match a Name filter of "account".
      expect(screen.getByText("AccountHandler")).toBeInTheDocument();
      expect(screen.queryByText("MyField__c")).not.toBeInTheDocument();
      expect(screen.queryByText("OpportunityTrigger")).not.toBeInTheDocument();
    });

    it("filters by Type independently of Name", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);

      fireEvent.change(screen.getByRole("textbox", { name: /filter by type/i }), { target: { value: "Trigger" } });

      expect(screen.getByText("OpportunityTrigger")).toBeInTheDocument();
      expect(screen.queryByText("AccountHandler")).not.toBeInTheDocument();
      expect(screen.queryByText("MyField__c")).not.toBeInTheDocument();
    });

    it("filters by Parent", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);

      fireEvent.change(screen.getByRole("textbox", { name: /filter by parent/i }), { target: { value: "Account" } });

      // Only "Account.MyField__c" has a Parent ("Account") — AccountHandler's Parent is blank
      // (its fullName has no dot), so it doesn't match a Parent filter even though its own name does.
      expect(screen.getByText("MyField__c")).toBeInTheDocument();
      expect(screen.queryByText("AccountHandler")).not.toBeInTheDocument();
    });

    it("filters by Modified By", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);

      fireEvent.change(screen.getByRole("textbox", { name: /filter by modified by/i }), { target: { value: "ada" } });

      expect(screen.getByText("AccountHandler")).toBeInTheDocument();
      expect(screen.getByText("MyField__c")).toBeInTheDocument();
      expect(screen.queryByText("OpportunityTrigger")).not.toBeInTheDocument();
    });

    it("combines multiple column filters with AND, not OR", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);

      fireEvent.change(screen.getByRole("textbox", { name: /filter by type/i }), { target: { value: "ApexClass" } });
      fireEvent.change(screen.getByRole("textbox", { name: /filter by modified by/i }), { target: { value: "bob" } });

      expect(dataRows()).toHaveLength(0);
    });

    it("combines with the status filter rather than overriding it", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);
      fireEvent.click(screen.getByRole("button", { name: /^filter/i }));
      fireEvent.click(within(screen.getByRole("group", { name: /filter by status/i })).getByRole("checkbox", { name: "Unchanged" }));

      fireEvent.change(screen.getByRole("textbox", { name: /filter by modified by/i }), { target: { value: "ada" } });

      // "Account.MyField__c" matches the Modified By filter but its status (Unchanged) is
      // filtered out by the status panel.
      expect(screen.getByText("AccountHandler")).toBeInTheDocument();
      expect(screen.queryByText("MyField__c")).not.toBeInTheDocument();
    });

    it("shows no rows when nothing matches", () => {
      render(<DiffTable items={ITEMS} selected={new Set()} onToggle={() => {}} />);

      fireEvent.change(screen.getByRole("textbox", { name: /filter by name/i }), { target: { value: "zzz-no-match" } });

      expect(dataRows()).toHaveLength(0);
    });
  });
});
