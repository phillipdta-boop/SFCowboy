import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ConnectionSummary,
  type Pipeline,
  type PipelineRunSummary,
  fetchConnections,
  fetchPipelines,
  fetchPipelineRuns,
  deletePipeline,
  updatePipelineStatus,
} from "../api/client.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export function Pipelines() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  // The most recent run per pipeline (or null once we know there isn't one) — just enough to show
  // an at-a-glance "how far along is this pipeline" indicator on the list; the precise per-stage
  // view already lives on the run's own detail page.
  const [latestRuns, setLatestRuns] = useState<Record<string, PipelineRunSummary | null>>({});
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchConnections().then(setConnections);
    fetchPipelines().then((list) => {
      setPipelines(list);
      Promise.all(
        list.map((p) =>
          fetchPipelineRuns(p.id).then((runs): [string, PipelineRunSummary | null] => [p.id, runs[0] ?? null])
        )
      ).then((entries) => setLatestRuns(Object.fromEntries(entries)));
    });
  }

  useEffect(refresh, []);

  function connectionFor(id: string): ConnectionSummary | undefined {
    return connections.find((c) => c.id === id);
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deletePipeline(id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleToggleStatus(p: Pipeline) {
    setError(null);
    try {
      await updatePipelineStatus(p.id, p.status === "active" ? "closed" : "active");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>
        Pipelines
        <Link to="/pipelines/new" className="page-action">
          New Pipeline
        </Link>
      </h1>
      {error && <p role="alert">{error}</p>}
      <ul>
        {pipelines.map((p) => {
          const latestRun = latestRuns[p.id];
          return (
            <li key={p.id}>
              <Link to={`/pipelines/${p.id}`}>
                <strong>{p.name}</strong>
              </Link>
              :{" "}
              <span className="env-flow">
                {p.connectionIds.map((id, i) => {
                  const connection = connectionFor(id);
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
              <button onClick={() => handleToggleStatus(p)}>{p.status === "active" ? "Close" : "Reopen"}</button>
              <button onClick={() => handleDelete(p.id)}>Delete</button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
