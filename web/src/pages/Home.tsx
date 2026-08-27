import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ConnectionSummary,
  type Pipeline,
  type DeploymentSummary,
  fetchConnections,
  fetchPipelines,
  fetchDeployments,
} from "../api/client.js";
import { nicknameFor, environmentBadge, formatDate } from "../deploymentDisplay.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export function Home() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [pipelineFilter, setPipelineFilter] = useState<"active" | "closed">("active");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchConnections(), fetchPipelines(), fetchDeployments()])
      .then(([c, p, d]) => {
        setConnections(c);
        setPipelines(p);
        setDeployments(d);
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const recentDeployments = [...deployments]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 5);

  const filteredPipelines = pipelines.filter((p) => p.status === pipelineFilter);

  return (
    <div>
      <h1>Home</h1>
      {error && <p role="alert">{error}</p>}

      <section>
        <h2>Recent Deployments</h2>
        {recentDeployments.length === 0 ? (
          <p>No deployments yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Deployment</th>
                  <th>Environments</th>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Test level</th>
                </tr>
              </thead>
              <tbody>
                {recentDeployments.map((d) => {
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
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2>Connections</h2>
        <ul>
          {connections.map((c) => (
            <li key={c.id}>
              <ConnectionTypeIcon type={c.type} /> <strong>{c.nickname}</strong>
              {c.type === "org" && c.orgType ? ` (${c.orgType})` : ""}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Pipelines</h2>
        <div role="group" aria-label="Filter pipelines by status">
          <button
            aria-pressed={pipelineFilter === "active"}
            onClick={() => setPipelineFilter("active")}
          >
            Active
          </button>
          <button
            aria-pressed={pipelineFilter === "closed"}
            onClick={() => setPipelineFilter("closed")}
          >
            Closed
          </button>
        </div>
        <ul>
          {filteredPipelines.map((p) => (
            <li key={p.id}>
              <strong>{p.name}</strong>: {p.connectionIds.map((id) => nicknameFor(connections, id)).join(" → ")}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
