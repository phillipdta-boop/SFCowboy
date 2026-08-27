import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { type ConnectionSummary, fetchConnections, createDraftDeployment, runDeployment } from "../api/client.js";
import { DeploymentEditor } from "../components/DeploymentEditor.js";

export function NewDeployment() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [title, setTitle] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  // Set once the draft is Saved — gates the source/target picker (phase 1) vs. the component
  // picker (phase 2). Source and target are fixed once a draft exists, so this doubles as the
  // "has the deployment been committed yet" flag.
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  async function handleSaveDraft() {
    setError(null);
    try {
      const { id } = await createDraftDeployment({
        title: title.trim() || undefined,
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
      });
      setDeploymentId(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function handleCancel() {
    navigate("/deploy");
  }

  if (!deploymentId) {
    return (
      <div>
        <h1>New Deployment</h1>
        {error && <p role="alert">{error}</p>}

        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="change summary ..." />
        </label>
        <label>
          Source
          <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">Select source</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
              </option>
            ))}
          </select>
        </label>
        <label>
          Target
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">Select target</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
              </option>
            ))}
          </select>
        </label>

        <button onClick={handleSaveDraft} disabled={!sourceId || !targetId}>
          Save
        </button>
        <button onClick={handleCancel}>Cancel</button>
      </div>
    );
  }

  return (
    <DeploymentEditor
      deploymentId={deploymentId}
      heading="New Deployment"
      title={title.trim() || null}
      sourceId={sourceId}
      targetId={targetId}
      connections={connections}
      onDeploy={(payload) => runDeployment(deploymentId, payload)}
      onDeployed={(id) => navigate(`/deployments/${id}`)}
      onCloned={(newId) => navigate(`/deployments/${newId}`)}
      onDeleted={() => navigate("/deploy")}
    />
  );
}
