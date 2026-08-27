import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { type ConnectionSummary, type DeploymentSummary, fetchConnections, fetchDeployments } from "../api/client.js";
import { nicknameFor, environmentBadge, formatDate } from "../deploymentDisplay.js";
import { StatusBadge } from "../components/StatusBadge.js";

export function History() {
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchDeployments(), fetchConnections()])
      .then(([d, c]) => {
        setDeployments(d);
        setConnections(c);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <div>
      <h1>History</h1>
      {error && <p role="alert">{error}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Deployment</th>
              <th>Environments</th>
              <th>Started</th>
              <th>Status</th>
              <th>Test level</th>
              <th>Run by</th>
            </tr>
          </thead>
          <tbody>
            {deployments.map((d) => {
              const source = nicknameFor(connections, d.source_connection_id);
              const target = nicknameFor(connections, d.target_connection_id);
              const label = d.title || `${source} → ${target}`;
              const sourceBadge = environmentBadge(connections, d.source_connection_id);
              const targetBadge = environmentBadge(connections, d.target_connection_id);
              return (
                <tr key={d.id}>
                  <td>
                    <Link to={`/deployments/${d.id}`}>{label}</Link>
                  </td>
                  <td>
                    <span className="env-flow">
                      <span>{source}</span>
                      <span className={`badge ${sourceBadge.className}`}>{sourceBadge.label}</span>
                      <span className="env-arrow" aria-hidden="true">
                        →
                      </span>
                      <span>{target}</span>
                      <span className={`badge ${targetBadge.className}`}>{targetBadge.label}</span>
                    </span>
                  </td>
                  <td>{formatDate(d.started_at)}</td>
                  <td>
                    <Link to={`/deployments/${d.id}`}>
                      <StatusBadge status={d.status} />
                    </Link>
                  </td>
                  <td>{d.test_level}</td>
                  <td>{d.run_by ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
