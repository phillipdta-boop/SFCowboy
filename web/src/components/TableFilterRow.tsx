export interface FilterColumn {
  key: string;
  // Omit for a column with nothing sensible to search on (e.g. a per-stage status cell) — that
  // column's cell renders blank instead of an input, but still holds its place in the row so
  // every column stays aligned with the header row above it.
  label?: string;
}

export interface TableFilterRowProps {
  columns: FilterColumn[];
  filters: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

/**
 * A second header row of per-column text filters, sitting directly under a table's sort-header
 * row — the same shape and matching rule (see tableFilter.ts) on every table in the app, so
 * "search" feels identical whether you're on Deployments, History, or a Pipeline Run's grid.
 */
export function TableFilterRow({ columns, filters, onChange }: TableFilterRowProps) {
  return (
    <tr className="table-filter-row">
      {columns.map((col) =>
        col.label ? (
          <th key={col.key}>
            <input
              type="text"
              aria-label={`Filter by ${col.label}`}
              placeholder="Filter…"
              value={filters[col.key] ?? ""}
              onChange={(e) => onChange(col.key, e.target.value)}
            />
          </th>
        ) : (
          <th key={col.key} />
        )
      )}
    </tr>
  );
}
