import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ConnectionSummary, type DeploymentSummary, fetchConnections, fetchDeployments } from "../api/client.js";
import { nicknameFor, environmentBadge, formatDate, formatStatusLabel, componentPath } from "../deploymentDisplay.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { TableFilterRow } from "../components/TableFilterRow.js";
import { matchesFilter } from "../tableFilter.js";

type SortField = "label" | "source" | "started_at" | "status" | "run_by";
type SortDir = "asc" | "desc";

const FILTER_COLUMNS = [
  { key: "label", label: "deployment" },
  { key: "environments", label: "environments" },
  { key: "started_at", label: "started" },
  { key: "status", label: "status" },
  { key: "test_level", label: "test level" },
  { key: "run_by", label: "run by" },
  { key: "components", label: "components" },
];

export function History() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("started_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [filters, setFilters] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([fetchDeployments(), fetchConnections()])
      .then(([d, c]) => {
        setDeployments(d);
        setConnections(c);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  function headerClick(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function sortIndicator(field: SortField) {
    if (field !== sortField) return null;
    return (
      <svg
        className="sort-chevron"
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ transform: sortDir === "desc" ? "rotate(180deg)" : undefined }}
      >
        <path d="m6 15 6-6 6 6" />
      </svg>
    );
  }

  const rows = deployments.map((d) => {
    const source = nicknameFor(connections, d.source_connection_id);
    const target = nicknameFor(connections, d.target_connection_id);
    const sourceBadge = environmentBadge(connections, d.source_connection_id);
    const targetBadge = environmentBadge(connections, d.target_connection_id);
    return {
      ...d,
      source,
      target,
      sourceBadge,
      targetBadge,
      label: d.title || `${source} → ${target}`,
      environmentsText: `${source} ${sourceBadge.label} ${target} ${targetBadge.label}`,
      startedLabel: formatDate(d.started_at),
      statusLabel: formatStatusLabel(d.status),
      runByText: d.run_by ?? "—",
      componentsText: d.items.map((item) => componentPath(item.metadata_type, item.api_name)).join(", "),
    };
  });

  const sorted = [...rows].sort((a, b) => {
    const av = (a[sortField] ?? "").toString();
    const bv = (b[sortField] ?? "").toString();
    const cmp = av.localeCompare(bv);
    return sortDir === "asc" ? cmp : -cmp;
  });

  const filtered = sorted.filter(
    (d) =>
      matchesFilter(d.label, filters.label ?? "") &&
      matchesFilter(d.environmentsText, filters.environments ?? "") &&
      matchesFilter(d.startedLabel, filters.started_at ?? "") &&
      matchesFilter(d.statusLabel, filters.status ?? "") &&
      matchesFilter(d.test_level, filters.test_level ?? "") &&
      matchesFilter(d.runByText, filters.run_by ?? "") &&
      matchesFilter(d.componentsText, filters.components ?? "")
  );

  return (
    <div>
      <h1>History</h1>
      <p>The complete record of every deployment, including automated pipeline steps.</p>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <div className="spinner" role="status" aria-label="Loading…" />
      ) : (
      <div className="table-scroll">
        <table className="deployments-table">
          <thead>
            <tr>
              <th>
                <button type="button" onClick={() => headerClick("label")}>
                  Deployment {sortIndicator("label")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("source")}>
                  Environments {sortIndicator("source")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("started_at")}>
                  Started {sortIndicator("started_at")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("status")}>
                  Status {sortIndicator("status")}
                </button>
              </th>
              <th>Test level</th>
              <th>
                <button type="button" onClick={() => headerClick("run_by")}>
                  Run by {sortIndicator("run_by")}
                </button>
              </th>
              <th>Components</th>
            </tr>
            <TableFilterRow
              columns={FILTER_COLUMNS}
              filters={filters}
              onChange={(key, value) => setFilters((prev) => ({ ...prev, [key]: value }))}
            />
          </thead>
          <tbody>
            {filtered.map((d) => {
              return (
                <tr key={d.id}>
                  <td>
                    <Link to={`/deployments/${d.id}`}>{d.label}</Link>
                  </td>
                  <td>
                    <span className="env-flow">
                      <span>{d.source}</span>
                      <span className={`badge ${d.sourceBadge.className}`}>{d.sourceBadge.label}</span>
                      <span className="env-arrow" aria-hidden="true">
                        →
                      </span>
                      <span>{d.target}</span>
                      <span className={`badge ${d.targetBadge.className}`}>{d.targetBadge.label}</span>
                    </span>
                  </td>
                  <td>{d.startedLabel}</td>
                  <td>
                    <Link to={`/deployments/${d.id}`}>
                      <StatusBadge status={d.status} />
                    </Link>
                  </td>
                  <td>{d.test_level}</td>
                  <td>{d.runByText}</td>
                  <td>
                    {/* Collapsed by default — a run can carry hundreds of components, which
                        would otherwise make every history row as tall as its biggest deploy. */}
                    <details className="history-components">
                      <summary>
                        {d.items.length} component{d.items.length === 1 ? "" : "s"}
                      </summary>
                      <ul>
                        {d.items.map((item) => (
                          <li key={`${item.metadata_type}::${item.api_name}`}>{componentPath(item.metadata_type, item.api_name)}</li>
                        ))}
                      </ul>
                    </details>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}
