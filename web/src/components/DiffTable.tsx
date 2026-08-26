import { useState } from "react";
import type { DiffItem } from "../api/client.js";

export function diffItemKey(item: { type: string; fullName: string }): string {
  return `${item.type}::${item.fullName}`;
}

const STATUS_LABEL: Record<DiffItem["status"], string> = {
  added: "New",
  modified: "Modified",
  removed: "Removed",
  unchanged: "Unchanged",
};

const STATUS_BADGE_CLASS: Record<DiffItem["status"], string> = {
  added: "badge-new",
  modified: "badge-modified",
  removed: "badge-removed",
  unchanged: "badge-unchanged",
};

function splitParentAndName(fullName: string): { parent: string; name: string } {
  const dot = fullName.lastIndexOf(".");
  if (dot === -1) return { parent: "", name: fullName };
  return { parent: fullName.slice(0, dot), name: fullName.slice(dot + 1) };
}

function formatDate(date?: string): string {
  if (!date) return "";
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}

type SortField = "name" | "type" | "parent" | "lastModifiedByName" | "lastModifiedDate";
type SortDir = "asc" | "desc";

export interface DiffTableProps {
  items: DiffItem[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  mode?: "select" | "remove";
}

export function DiffTable({ items, selected, onToggle, mode = "select" }: DiffTableProps) {
  const [sortField, setSortField] = useState<SortField>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function headerClick(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function sortIndicator(field: SortField): string {
    if (field !== sortField) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  }

  const rows = items.map((item) => ({ ...item, ...splitParentAndName(item.fullName) }));
  const sorted = [...rows].sort((a, b) => {
    const av = (a[sortField] ?? "").toString();
    const bv = (b[sortField] ?? "").toString();
    const cmp = av.localeCompare(bv);
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <table>
      <thead>
        <tr>
          <th>
            <button type="button" onClick={() => headerClick("name")}>
              Name{sortIndicator("name")}
            </button>
          </th>
          <th>
            <button type="button" onClick={() => headerClick("type")}>
              Type{sortIndicator("type")}
            </button>
          </th>
          <th>
            <button type="button" onClick={() => headerClick("parent")}>
              Parent{sortIndicator("parent")}
            </button>
          </th>
          <th>
            <button type="button" onClick={() => headerClick("lastModifiedByName")}>
              Modified By{sortIndicator("lastModifiedByName")}
            </button>
          </th>
          <th>
            <button type="button" onClick={() => headerClick("lastModifiedDate")}>
              Modified Date{sortIndicator("lastModifiedDate")}
            </button>
          </th>
          <th>{mode === "remove" ? "Remove" : "Select"}</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((item) => {
          const key = diffItemKey(item);
          return (
            <tr key={key}>
              <td>{item.name}</td>
              <td>{item.type}</td>
              <td>{item.parent}</td>
              <td>{item.lastModifiedByName ?? ""}</td>
              <td>{formatDate(item.lastModifiedDate)}</td>
              <td>
                {mode === "remove" ? (
                  <button type="button" aria-label={`Remove ${item.fullName}`} onClick={() => onToggle(key)}>
                    ×
                  </button>
                ) : (
                  <input
                    type="checkbox"
                    aria-label={item.fullName}
                    checked={selected.has(key)}
                    onChange={() => onToggle(key)}
                    disabled={item.status === "unchanged"}
                  />
                )}
              </td>
              <td>
                <span className={`badge ${STATUS_BADGE_CLASS[item.status]}`}>{STATUS_LABEL[item.status]}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
