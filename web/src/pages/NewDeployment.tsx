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
  // Overrides for a git source/target's own default branch — blank means "use that connection's
  // default." Only ever sent when the chosen connection is actually a git one.
  const [sourceBranch, setSourceBranch] = useState("");
  const [targetBranch, setTargetBranch] = useState("");
  // Set once the draft is Saved — gates the source/target picker (phase 1) vs. the component
  // picker (phase 2). Source and target are fixed once a draft exists, so this doubles as the
  // "has the deployment been committed yet" flag.
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  const sourceConnection = connections.find((c) => c.id === sourceId);
  const targetConnection = connections.find((c) => c.id === targetId);

  async function handleSaveDraft() {
    setError(null);
    try {
      const { id } = await createDraftDeployment({
        title: title.trim() || undefined,
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        sourceBranch: sourceConnection?.type === "git" ? sourceBranch.trim() || undefined : undefined,
        targetBranch: targetConnection?.type === "git" ? targetBranch.trim() || undefined : undefined,
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
          <select
            value={sourceId}
            onChange={(e) => {
              const id = e.target.value;
              setSourceId(id);
              setSourceBranch(connections.find((c) => c.id === id)?.defaultBranch ?? "");
            }}
          >
            <option value="">Select source</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
              </option>
            ))}
          </select>
        </label>
        {sourceConnection?.type === "git" && (
          <label>
            Source Branch
            <input value={sourceBranch} onChange={(e) => setSourceBranch(e.target.value)} />
          </label>
        )}
        <label>
          Target
          <select
            value={targetId}
            onChange={(e) => {
              const id = e.target.value;
              setTargetId(id);
              setTargetBranch(connections.find((c) => c.id === id)?.defaultBranch ?? "");
            }}
          >
            <option value="">Select target</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.nickname}
              </option>
            ))}
          </select>
        </label>
        {targetConnection?.type === "git" && (
          <label>
            Target Branch
            <input value={targetBranch} onChange={(e) => setTargetBranch(e.target.value)} />
          </label>
        )}

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
      sourceBranch={sourceConnection?.type === "git" ? sourceBranch.trim() || undefined : undefined}
      targetBranch={targetConnection?.type === "git" ? targetBranch.trim() || undefined : undefined}
      onDeploy={(payload) => runDeployment(deploymentId, payload)}
      onDeployed={(id) => navigate(`/deployments/${id}`)}
      onCloned={(newId) => navigate(`/deployments/${newId}`)}
      onDeleted={() => navigate("/deploy")}
    />
  );
}
