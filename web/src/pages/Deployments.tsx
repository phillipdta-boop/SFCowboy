import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ConnectionSummary, type DeploymentSummary, fetchConnections, fetchDeployments } from "../api/client.js";

const STATUS_BADGE_CLASS: Record<string, string> = {
  succeeded: "badge-new",
  failed: "badge-removed",
  rolled_back: "badge-unchanged",
  cancelled: "badge-unchanged",
  pending: "badge-modified",
  validating: "badge-modified",
  deploying: "badge-modified",
};

function nicknameFor(connections: ConnectionSummary[], id: string): string {
  return connections.find((c) => c.id === id)?.nickname ?? id;
}

// Flags what kind of environment a connection is, so a row makes it obvious at a glance whether
// a deployment is headed into a sandbox or — worth a second look — Production.
function environmentBadge(connections: ConnectionSummary[], id: string): { label: string; className: string } {
  const conn = connections.find((c) => c.id === id);
  if (!conn) return { label: "Unknown", className: "badge-unchanged" };
  if (conn.type === "git") return { label: "Git", className: "badge-unchanged" };
  if (conn.orgType === "production") return { label: "Production", className: "badge-removed" };
  if (conn.orgType === "sandbox") return { label: "Sandbox", className: "badge-new" };
  return { label: "Org", className: "badge-unchanged" };
}

function formatDate(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}

type SortField = "label" | "source" | "target" | "status" | "started_at";
type SortDir = "asc" | "desc";

export function Deployments() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortField, setSortField] = useState<SortField>("started_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  useEffect(() => {
    Promise.all([fetchDeployments(), fetchConnections()])
      .then(([d, c]) => {
        setDeployments(d);
        setConnections(c);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

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
      {error && <p role="alert">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <button type="button" onClick={() => headerClick("label")}>
                  Deployment{sortIndicator("label")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("source")}>
                  Environments{sortIndicator("source")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("status")}>
                  Last Status{sortIndicator("status")}
                </button>
              </th>
              <th>
                <button type="button" onClick={() => headerClick("started_at")}>
                  Created Date{sortIndicator("started_at")}
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
                    <span className={`badge ${STATUS_BADGE_CLASS[d.status] ?? "badge-unchanged"}`}>{d.status}</span>
                  </td>
                  <td>{formatDate(d.started_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
