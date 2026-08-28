import { useCallback, useRef, useState } from "react";
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

const ALL_STATUSES: DiffItem["status"][] = ["added", "modified", "removed", "unchanged"];

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

type SortField = "name" | "type" | "parent" | "lastModifiedByName" | "lastModifiedDate" | "statusLabel";
type SortDir = "asc" | "desc";

// Percentages of the table's own width, not the viewport — the table already fills its
// container (see the `table { width: 100% }` rule), so columns sized this way always add up to
// exactly 100% of whatever room is actually available, on any screen.
type ColumnKey = "name" | "type" | "parent" | "modifiedBy" | "modifiedDate" | "action" | "status";
const COLUMN_ORDER: ColumnKey[] = ["name", "type", "parent", "modifiedBy", "modifiedDate", "action", "status"];
const DEFAULT_WIDTHS: Record<ColumnKey, number> = {
  name: 24,
  type: 14,
  parent: 16,
  modifiedBy: 16,
  modifiedDate: 14,
  action: 8,
  status: 8,
};
// A dragged divider can't shrink either side below this, so a column can be squeezed for room
// but never squeezed away entirely.
const MIN_COLUMN_WIDTH = 6;

export interface DiffTableProps {
  items: DiffItem[];
  selected: Set<string>;
  onToggle: (key: string) => void;
  mode?: "select" | "remove";
}

interface ResizeState {
  left: ColumnKey;
  right: ColumnKey;
  startX: number;
  startLeft: number;
  startRight: number;
}

export function DiffTable({ items, selected, onToggle, mode = "select" }: DiffTableProps) {
  const [sortField, setSortField] = useState<SortField>("type");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(DEFAULT_WIDTHS);
  const [visibleStatuses, setVisibleStatuses] = useState<Set<DiffItem["status"]>>(new Set(ALL_STATUSES));
  const [filterOpen, setFilterOpen] = useState(false);
  const [search, setSearch] = useState("");
  const tableRef = useRef<HTMLTableElement>(null);
  const resizing = useRef<ResizeState | null>(null);

  // Dragging the handle between two columns grows one and shrinks its neighbor by the same
  // amount, so the table's total width — and therefore whether it fits the screen — never
  // changes; only how the fixed total is divided up does.
  const handleMouseMove = useCallback((e: MouseEvent) => {
    const state = resizing.current;
    const table = tableRef.current;
    if (!state || !table) return;
    const tableWidth = table.getBoundingClientRect().width;
    if (tableWidth === 0) return;
    const rawDelta = ((e.clientX - state.startX) / tableWidth) * 100;
    const delta = Math.max(
      MIN_COLUMN_WIDTH - state.startLeft,
      Math.min(state.startRight - MIN_COLUMN_WIDTH, rawDelta)
    );
    setColumnWidths((prev) => ({
      ...prev,
      [state.left]: state.startLeft + delta,
      [state.right]: state.startRight - delta,
    }));
  }, []);

  const stopResize = useCallback(() => {
    resizing.current = null;
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", stopResize);
  }, [handleMouseMove]);

  function startResize(left: ColumnKey, right: ColumnKey) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      resizing.current = { left, right, startX: e.clientX, startLeft: columnWidths[left], startRight: columnWidths[right] };
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", stopResize);
    };
  }

  function ResizeHandle({ column }: { column: ColumnKey }) {
    const index = COLUMN_ORDER.indexOf(column);
    const next = COLUMN_ORDER[index + 1];
    if (!next) return null;
    return <span className="col-resize-handle" aria-hidden="true" onMouseDown={startResize(column, next)} />;
  }

  function toggleStatusVisible(status: DiffItem["status"]) {
    setVisibleStatuses((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }

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

  const rows = items.map((item) => ({
    ...item,
    ...splitParentAndName(item.fullName),
    statusLabel: STATUS_LABEL[item.status],
  }));
  const sorted = [...rows].sort((a, b) => {
    const av = (a[sortField] ?? "").toString();
    const bv = (b[sortField] ?? "").toString();
    const cmp = av.localeCompare(bv);
    return sortDir === "asc" ? cmp : -cmp;
  });
  const searchTerm = search.trim().toLowerCase();
  const visible = sorted
    .filter((item) => visibleStatuses.has(item.status))
    .filter((item) => searchTerm === "" || item.fullName.toLowerCase().includes(searchTerm) || item.type.toLowerCase().includes(searchTerm));

  return (
    <>
      <input
        type="search"
        className="component-search"
        placeholder="Search components…"
        aria-label="Search components"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="status-filter">
        <button type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen((v) => !v)}>
          Filter
          {visibleStatuses.size < ALL_STATUSES.length ? ` (${visibleStatuses.size}/${ALL_STATUSES.length})` : ""}
          {filterOpen ? " ▲" : " ▼"}
        </button>
        {filterOpen && (
          <div className="status-filter-options" role="group" aria-label="Filter by status">
            {ALL_STATUSES.map((status) => (
              <label key={status}>
                <input type="checkbox" checked={visibleStatuses.has(status)} onChange={() => toggleStatusVisible(status)} />
                <span className={`badge ${STATUS_BADGE_CLASS[status]}`}>{STATUS_LABEL[status]}</span>
              </label>
            ))}
            <div className="status-filter-actions">
              <button type="button" onClick={() => setVisibleStatuses(new Set(ALL_STATUSES))}>
                Select all
              </button>
              <button type="button" onClick={() => setVisibleStatuses(new Set())}>
                Select none
              </button>
            </div>
          </div>
        )}
      </div>

      <table className="resizable-table" ref={tableRef}>
        <colgroup>
          {COLUMN_ORDER.map((col) => (
            <col key={col} style={{ width: `${columnWidths[col]}%` }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th>
              <button type="button" onClick={() => headerClick("name")}>
                Name{sortIndicator("name")}
              </button>
              <ResizeHandle column="name" />
            </th>
            <th>
              <button type="button" onClick={() => headerClick("type")}>
                Type{sortIndicator("type")}
              </button>
              <ResizeHandle column="type" />
            </th>
            <th>
              <button type="button" onClick={() => headerClick("parent")}>
                Parent{sortIndicator("parent")}
              </button>
              <ResizeHandle column="parent" />
            </th>
            <th>
              <button type="button" onClick={() => headerClick("lastModifiedByName")}>
                Modified By{sortIndicator("lastModifiedByName")}
              </button>
              <ResizeHandle column="modifiedBy" />
            </th>
            <th>
              <button type="button" onClick={() => headerClick("lastModifiedDate")}>
                Modified Date{sortIndicator("lastModifiedDate")}
              </button>
              <ResizeHandle column="modifiedDate" />
            </th>
            <th>
              {mode === "remove" ? "Remove" : "Select"}
              <ResizeHandle column="action" />
            </th>
            <th>
              <button type="button" onClick={() => headerClick("statusLabel")}>
                Status{sortIndicator("statusLabel")}
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((item) => {
            const key = diffItemKey(item);
            return (
              <tr key={key}>
                <td title={item.name}>{item.name}</td>
                <td title={item.type}>{item.type}</td>
                <td title={item.parent}>{item.parent}</td>
                <td title={item.lastModifiedByName ?? ""}>{item.lastModifiedByName ?? ""}</td>
                <td title={formatDate(item.lastModifiedDate)}>{formatDate(item.lastModifiedDate)}</td>
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
    </>
  );
}
