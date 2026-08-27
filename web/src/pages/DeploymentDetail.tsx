import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  type DeploymentDetail,
  fetchConnections,
  fetchDeployment,
  rollbackDeployment,
  rerunDeployment,
  cancelDeployment,
} from "../api/client.js";
import { DeploymentEditor } from "../components/DeploymentEditor.js";
import { DeploymentActions } from "../components/DeploymentActions.js";
import { ProgressBar } from "../components/ProgressBar.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);
const IN_PROGRESS_STATUSES = new Set(["validating", "deploying"]);

function statusBannerClass(status: string): string {
  if (IN_PROGRESS_STATUSES.has(status)) return "status-banner status-banner-in-progress";
  if (status === "succeeded") return "status-banner status-banner-succeeded";
  if (status === "failed") return "status-banner status-banner-failed";
  return "status-banner status-banner-neutral";
}

function statusMessage(status: string): string {
  switch (status) {
    case "validating":
      return "Validate action is in progress …";
    case "deploying":
      return "Deploy action is in progress …";
    case "succeeded":
      return "Deployment succeeded";
    case "failed":
      return "Deployment failed";
    case "cancelled":
      return "Deployment cancelled";
    case "rolled_back":
      return "Deployment rolled back";
    default:
      return status;
  }
}

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
  const [rerunError, setRerunError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
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

  // Re-running clones this deployment into a fresh row and starts it — the run this page is
  // showing stays exactly as it finished, and the new run gets its own history entry, so we
  // navigate to it rather than trying to reuse this page for two different runs at once.
  async function handleRerun(validateOnly: boolean) {
    if (!id) return;
    setRerunError(null);
    try {
      const { id: newId } = await rerunDeployment(id, { validateOnly });
      navigate(`/deployments/${newId}`);
    } catch (err) {
      setRerunError((err as Error).message);
    }
  }

  async function handleCancel() {
    if (!id) return;
    setCancelError(null);
    setCancelling(true);
    try {
      await cancelDeployment(id);
    } catch (err) {
      setCancelError((err as Error).message);
    } finally {
      setCancelling(false);
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
  const inProgress = IN_PROGRESS_STATUSES.has(deployment.status);
  const canRerun = TERMINAL_STATUSES.has(deployment.status);

  return (
    <div>
      <h1>
        Deployment: {deployment.title || `${nicknameFor(connections, deployment.source_connection_id)} → ${nicknameFor(connections, deployment.target_connection_id)}`}
      </h1>

      <div className={statusBannerClass(deployment.status)}>
        <p className="status-banner-message">
          {inProgress && <span className="spinner" role="status" aria-label="In progress" />}
          {statusMessage(deployment.status)}
        </p>
        <p>Status: {deployment.status}</p>
        <p>Test level: {deployment.test_level}</p>
        {deployment.validate_only ? <p>Validation only (dry run)</p> : null}
        {deployment.components_total !== null && (
          <ProgressBar label="Components" value={deployment.components_deployed ?? 0} max={deployment.components_total} />
        )}
        {deployment.test_level !== "NoTestRun" && deployment.tests_total !== null && (
          <ProgressBar label="Apex tests" value={deployment.tests_completed ?? 0} max={deployment.tests_total} />
        )}
        <p className="status-banner-meta">Start time: {new Date(deployment.started_at).toLocaleString()}</p>
        {deployment.error_detail && <pre>{deployment.error_detail}</pre>}
      </div>

      {rollbackError && <p role="alert">{rollbackError}</p>}
      {rerunError && <p role="alert">{rerunError}</p>}
      {cancelError && <p role="alert">{cancelError}</p>}
      {pollError && <p role="alert">{pollError}</p>}

      <div className="deployment-toolbar">
        {inProgress && (
          <button type="button" onClick={handleCancel} disabled={cancelling}>
            Cancel
          </button>
        )}
        {canRerun && (
          <>
            <button type="button" onClick={() => handleRerun(true)}>
              Validate again
            </button>
            <button type="button" onClick={() => handleRerun(false)}>
              Deploy again
            </button>
          </>
        )}
        {canRollBack && <button onClick={handleRollback}>Roll back</button>}
        <DeploymentActions
          deploymentId={deployment.id}
          title={deployment.title}
          onTitleChange={(next) => setDeployment((prev) => (prev ? { ...prev, title: next } : prev))}
          onCloned={(newId) => navigate(`/deployments/${newId}`)}
          onDeleted={() => navigate("/deploy")}
        />
      </div>

      <ul>
        {deployment.items.map((item) => (
          <li key={`${item.metadata_type}::${item.api_name}`}>
            {item.metadata_type} {item.api_name} — {item.status}
            {item.error_message ? `: ${item.error_message}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
