import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ConnectionSummary, type DeploymentSummary, fetchConnections, fetchDeployments } from "../api/client.js";
import { nicknameFor, environmentBadge, formatDate } from "../deploymentDisplay.js";
import { StatusBadge } from "../components/StatusBadge.js";

type SortField = "label" | "source" | "target" | "status" | "started_at";
type SortDir = "asc" | "desc";

export function Deployments() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("started_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    Promise.all([fetchDeployments(), fetchConnections()])
      .then(([d, c]) => {
        // Deployments started as a hop of a pipeline run live on that run's own page — this page
        // is for deployments a user starts directly. History still lists everything, including
        // these, as the complete audit trail.
        setDeployments(d.filter((dep) => !dep.pipeline_run_id));
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
    return { ...d, source, target, label: d.title || `${source} → ${target}` };
  });

  const sorted = [...rows].sort((a, b) => {
    const av = (a[sortField] ?? "").toString();
    const bv = (b[sortField] ?? "").toString();
    const cmp = av.localeCompare(bv);
    return sortDir === "asc" ? cmp : -cmp;
  });

  return (
    <div>
      <h1>
        Deployments
        <Link to="/deploy/new" className="page-action">
          New Deployment
        </Link>
      </h1>
      <p>Deployments you start directly. Steps run as part of a pipeline live on that pipeline's own page — see History for the complete record of every deployment.</p>
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
                <button type="button" onClick={() => headerClick("status")}>
                  Last Status {sortIndicator("status")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("started_at")}>
                  Created Date {sortIndicator("started_at")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((d) => {
              const sourceBadge = environmentBadge(connections, d.source_connection_id);
              const targetBadge = environmentBadge(connections, d.target_connection_id);
              return (
                <tr key={d.id}>
                  <td>
                    <Link to={`/deployments/${d.id}`}>{d.label}</Link>
                  </td>
                  <td>
                    <span className="env-flow">
                      <span>{d.source}</span>
                      <span className={`badge ${sourceBadge.className}`}>{sourceBadge.label}</span>
                      <span className="env-arrow" aria-hidden="true">
                        →
                      </span>
                      <span>{d.target}</span>
                      <span className={`badge ${targetBadge.className}`}>{targetBadge.label}</span>
                    </span>
                  </td>
                  <td>
                    <Link to={`/deployments/${d.id}`}>
                      <StatusBadge status={d.status} />
                    </Link>
                  </td>
                  <td>{formatDate(d.started_at)}</td>
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
