import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ConnectionSummary,
  type Pipeline,
  type PipelineRunSummary,
  type DeploymentSummary,
  fetchConnections,
  fetchPipelines,
  fetchPipelineRuns,
  fetchDeployments,
} from "../api/client.js";
import { nicknameFor, environmentBadge, formatDate } from "../deploymentDisplay.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export function Home() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  // Mirrors Pipelines.tsx's own at-a-glance run indicator, so a pipeline reads the same way here
  // as it does on its own list page.
  const [latestRuns, setLatestRuns] = useState<Record<string, PipelineRunSummary | null>>({});
  const [deployments, setDeployments] = useState<DeploymentSummary[]>([]);
  const [pipelineFilter, setPipelineFilter] = useState<"active" | "closed">("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchConnections(), fetchPipelines(), fetchDeployments()])
      .then(([c, p, d]) => {
        setConnections(c);
        setPipelines(p);
        setDeployments(d);
        Promise.all(
          p.map((pipeline) =>
            fetchPipelineRuns(pipeline.id).then((runs): [string, PipelineRunSummary | null] => [pipeline.id, runs[0] ?? null])
          )
        ).then((entries) => setLatestRuns(Object.fromEntries(entries)));
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const recentDeployments = [...deployments]
    .sort((a, b) => b.started_at.localeCompare(a.started_at))
    .slice(0, 5);

  const filteredPipelines = pipelines.filter((p) => p.status === pipelineFilter);

  return (
    <div>
      <h1>Home</h1>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <div className="spinner" role="status" aria-label="Loading…" />
      ) : (
      <>
      <section>
        <h2>Recent Deployments</h2>
        {recentDeployments.length === 0 ? (
          <p>No deployments yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="deployments-table">
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
          {connections.map((c) => {
            const badge = environmentBadge(connections, c.id);
            return (
              <li key={c.id}>
                <ConnectionTypeIcon type={c.type} /> <strong>{c.nickname}</strong>{" "}
                <span className={`badge ${badge.className}`}>{badge.label}</span>
              </li>
            );
          })}
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
          {filteredPipelines.map((p) => {
            const latestRun = latestRuns[p.id];
            return (
              <li key={p.id}>
                <Link to={`/pipelines/${p.id}`}>
                  <strong>{p.name}</strong>
                </Link>
                :{" "}
                <span className="env-flow">
                  {p.connectionIds.map((id, i) => {
                    const connection = connections.find((c) => c.id === id);
                    return (
                      <span key={id} className="env-flow">
                        {i > 0 && (
                          <span className="env-arrow" aria-hidden="true">
                            →
                          </span>
                        )}
                        {connection && <ConnectionTypeIcon type={connection.type} />}
                        <span>{connection?.nickname ?? id}</span>
                      </span>
                    );
                  })}
                </span>{" "}
                <span className={`badge badge-${p.status}`}>{p.status}</span>{" "}
                {latestRun === undefined ? null : latestRun === null ? (
                  <span className="badge badge-unchanged">No runs yet</span>
                ) : (
                  <span className={`badge ${latestRun.componentsAtFinalStage >= latestRun.componentCount ? "badge-new" : "badge-modified"}`}>
                    Latest run: {latestRun.componentsAtFinalStage} / {latestRun.componentCount} at final stage
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </section>
      </>
      )}
    </div>
  );
}
