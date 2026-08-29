import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  type ConnectionSummary,
  type Pipeline,
  fetchConnections,
  fetchPipelines,
  createPipeline,
  deletePipeline,
  updatePipelineStatus,
} from "../api/client.js";

export function Pipelines() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [name, setName] = useState("");
  const [orderedSelection, setOrderedSelection] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchConnections().then(setConnections);
    fetchPipelines().then(setPipelines);
  }

  useEffect(refresh, []);

  function nicknameFor(id: string): string {
    return connections.find((c) => c.id === id)?.nickname ?? id;
  }

  function toggleConnection(id: string) {
    setOrderedSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createPipeline({ name, connectionIds: orderedSelection });
      setName("");
      setOrderedSelection([]);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
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
      <h1>Pipelines</h1>
      {error && <p role="alert">{error}</p>}
      <ul>
        {pipelines.map((p) => (
          <li key={p.id}>
            <Link to={`/pipelines/${p.id}`}><strong>{p.name}</strong></Link>: {p.connectionIds.map(nicknameFor).join(" → ")}{" "}
            <span className={`badge badge-${p.status}`}>{p.status}</span>
            <button onClick={() => handleToggleStatus(p)}>{p.status === "active" ? "Close" : "Reopen"}</button>
            <button onClick={() => handleDelete(p.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <h2>Create Pipeline</h2>
      <form onSubmit={handleCreate}>
        <label>
          Pipeline name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p>Select connections in the order they should appear (click order = pipeline order):</p>
        {connections.map((c) => (
          <label key={c.id}>
            <input type="checkbox" checked={orderedSelection.includes(c.id)} onChange={() => toggleConnection(c.id)} />
            {c.nickname}
          </label>
        ))}
        <button type="submit">Create pipeline</button>
      </form>
    </div>
  );
}
