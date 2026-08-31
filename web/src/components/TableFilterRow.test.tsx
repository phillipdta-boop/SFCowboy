import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TableFilterRow } from "./TableFilterRow.js";

describe("TableFilterRow", () => {
  it("renders a labeled filter input for each filterable column", () => {
    render(
      <table>
        <thead>
          <TableFilterRow
            columns={[{ key: "label", label: "deployment" }, { key: "status", label: "status" }]}
            filters={{}}
            onChange={() => {}}
          />
        </thead>
      </table>
    );

    expect(screen.getByRole("textbox", { name: /filter by deployment/i })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /filter by status/i })).toBeInTheDocument();
  });

  it("renders a blank cell (no input) for a column with no label", () => {
    render(
      <table>
        <thead>
          <TableFilterRow columns={[{ key: "label", label: "deployment" }, { key: "actions" }]} filters={{}} onChange={() => {}} />
        </thead>
      </table>
    );

    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });

  it("shows each input's current filter value", () => {
    render(
      <table>
        <thead>
          <TableFilterRow columns={[{ key: "label", label: "deployment" }]} filters={{ label: "sprint" }} onChange={() => {}} />
        </thead>
      </table>
    );

    expect(screen.getByRole("textbox", { name: /filter by deployment/i })).toHaveValue("sprint");
  });

  it("calls onChange with the column key and new value when typed into", () => {
    const onChange = vi.fn();
    render(
      <table>
        <thead>
          <TableFilterRow columns={[{ key: "label", label: "deployment" }]} filters={{}} onChange={onChange} />
        </thead>
      </table>
    );

    fireEvent.change(screen.getByRole("textbox", { name: /filter by deployment/i }), { target: { value: "hotfix" } });
    expect(onChange).toHaveBeenCalledWith("label", "hotfix");
  });
});
