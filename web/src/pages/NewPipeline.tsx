import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { type ConnectionSummary, fetchConnections, createPipeline } from "../api/client.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export function NewPipeline() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [name, setName] = useState("");
  // The order components are added in IS the pipeline's stage order — each connection's position
  // in this array is exactly the number shown next to it, so there's no separate "reorder" step
  // to get wrong.
  const [orderedSelection, setOrderedSelection] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  function toggleConnection(id: string) {
    setOrderedSelection((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      const pipeline = await createPipeline({ name, connectionIds: orderedSelection });
      navigate(`/pipelines/${pipeline.id}`);
    } catch (err) {
      setError((err as Error).message);
      setCreating(false);
    }
  }

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/pipelines">Pipelines</Link>
        <span aria-hidden="true"> › </span>
        <span>New Pipeline</span>
      </nav>
      <h1>New Pipeline</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleCreate}>
        <label>
          Pipeline name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p>
          Select connections in the order they should appear — each one's sequence number shows the stage it will be
          in this pipeline. Click again to remove it.
        </p>
        <ul className="pipeline-sequence-picker">
          {connections.map((c) => {
            const position = orderedSelection.indexOf(c.id);
            const selected = position !== -1;
            return (
              <li key={c.id}>
                <label>
                  <input type="checkbox" checked={selected} onChange={() => toggleConnection(c.id)} />
                  {selected && <span className="pipeline-sequence-number">{position + 1}</span>}
                  <ConnectionTypeIcon type={c.type} />
                  {c.nickname}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="form-actions">
          <button type="submit" disabled={creating || !name.trim() || orderedSelection.length < 2}>
            {creating ? "Creating…" : "Create pipeline"}
          </button>
          <button type="button" onClick={() => navigate("/pipelines")}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
