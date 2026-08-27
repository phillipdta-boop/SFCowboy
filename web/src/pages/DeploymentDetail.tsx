import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  type DeploymentDetail,
  fetchConnections,
  fetchDeployment,
  rollbackDeployment,
} from "../api/client.js";
import { DeploymentEditor } from "../components/DeploymentEditor.js";
import { DeploymentActions } from "../components/DeploymentActions.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back"]);

function nicknameFor(connections: ConnectionSummary[], id: string): string {
  return connections.find((c) => c.id === id)?.nickname ?? id;
}

export function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  // Bumped after the user deploys a pending draft from this page, to restart the poll loop below
  // now that the deployment has left 'pending' and needs to be watched for progress again.
  const [pollGeneration, setPollGeneration] = useState(0);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Tracks whether we've ever successfully loaded the deployment, independent of React state
    // (which updates asynchronously and wouldn't be visible to this closure's later invocations).
    // Used to tell a genuine initial-load failure (nothing to show yet — blank to an error) apart
    // from a transient failure on a later poll (deployment is already showing — don't hide it).
    let hasLoadedOnce = false;

    async function poll() {
      try {
        const detail = await fetchDeployment(id!);
        if (cancelled) return;
        hasLoadedOnce = true;
        setDeployment(detail);
        setPollError(null);
        // A 'pending' draft only changes once the user deploys it from this same page — nothing
        // else moves it along, so there's nothing to poll for until then (see pollGeneration).
        if (detail.status !== "pending" && !TERMINAL_STATUSES.has(detail.status)) {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (cancelled) return;
        if (hasLoadedOnce) {
          // A later poll failed after we already have a deployment on screen: surface the error
          // without hiding the view, and keep polling so it can recover on its own.
          setPollError((err as Error).message);
          timer = setTimeout(poll, 2000);
        } else {
          // The very first fetch failed: there's nothing to show yet, so blank to an error.
          setLoadError((err as Error).message);
        }
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, pollGeneration]);

  async function handleRollback() {
    if (!id) return;
    setRollbackError(null);
    try {
      const { id: rollbackId } = await rollbackDeployment(id);
      navigate(`/deployments/${rollbackId}`);
    } catch (err) {
      setRollbackError((err as Error).message);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!deployment) return <p>Loading…</p>;

  // A pending deployment is a draft that hasn't been run yet — reopen it in the same
  // component-picking editor used to create it, so the user can keep adding components or
  // adjust their selection before deploying, exactly as they would for a brand-new deployment.
  if (deployment.status === "pending") {
    return (
      <DeploymentEditor
        deploymentId={deployment.id}
        heading="Deployment"
        title={deployment.title}
        sourceId={deployment.source_connection_id}
        targetId={deployment.target_connection_id}
        connections={connections}
        initialComponents={deployment.components}
        onDeployed={() => setPollGeneration((g) => g + 1)}
        onCloned={(newId) => navigate(`/deployments/${newId}`)}
        onDeleted={() => navigate("/deploy")}
      />
    );
  }

  // A validate-only run never touched the target, so "rolling it back" would be a real
  // destructive deploy against metadata the dry run never changed. A git target has no rollback
  // path at all (the original deployment was a commit). The backend rejects both; don't offer them.
  const canRollBack =
    deployment.status === "succeeded" && !deployment.validate_only && deployment.target_connection_type === "org";

  return (
    <div>
      <h1>
        Deployment: {deployment.title || `${nicknameFor(connections, deployment.source_connection_id)} → ${nicknameFor(connections, deployment.target_connection_id)}`}
      </h1>
      <div className="deployment-toolbar">
        <DeploymentActions
          deploymentId={deployment.id}
          title={deployment.title}
          onTitleChange={(next) => setDeployment((prev) => (prev ? { ...prev, title: next } : prev))}
          onCloned={(newId) => navigate(`/deployments/${newId}`)}
          onDeleted={() => navigate("/deploy")}
        />
      </div>
      {rollbackError && <p role="alert">{rollbackError}</p>}
      {pollError && <p role="alert">{pollError}</p>}
      <p>Status: {deployment.status}</p>
      <p>Test level: {deployment.test_level}</p>
      {deployment.validate_only ? <p>Validation only (dry run)</p> : null}
      {deployment.error_detail && <pre>{deployment.error_detail}</pre>}
      <ul>
        {deployment.items.map((item) => (
          <li key={`${item.metadata_type}::${item.api_name}`}>
            {item.metadata_type} {item.api_name} — {item.status}
            {item.error_message ? `: ${item.error_message}` : ""}
          </li>
        ))}
      </ul>
      {canRollBack && <button onClick={handleRollback}>Roll back</button>}
    </div>
  );
}
