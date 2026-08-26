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

  function nicknameFor(id: string): string {
    return connections.find((c) => c.id === id)?.nickname ?? id;
  }

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
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recentDeployments.map((d) => (
                <tr key={d.id}>
                  <td>{d.started_at}</td>
                  <td>
                    <Link to={`/deployments/${d.id}`}>{d.status}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>Connections</h2>
        <ul>
          {connections.map((c) => (
            <li key={c.id}>
              <strong>{c.nickname}</strong> ({c.type})
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
              <strong>{p.name}</strong>: {p.connectionIds.map(nicknameFor).join(" → ")}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
