import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  type DeploymentDetail,
  fetchConnections,
  fetchDeployment,
  rollbackDeployment,
  runDeployment,
  rerunDeployment,
  cancelDeployment,
} from "../api/client.js";
import { DeploymentEditor } from "../components/DeploymentEditor.js";
import { ProgressBar } from "../components/ProgressBar.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);
const IN_PROGRESS_STATUSES = new Set(["validating", "deploying"]);

function statusBannerClass(status: string): string {
  if (IN_PROGRESS_STATUSES.has(status)) return "status-banner status-banner-in-progress";
  if (status === "succeeded") return "status-banner status-banner-succeeded";
  if (status === "failed") return "status-banner status-banner-failed";
  return "status-banner status-banner-neutral";
}

// error_detail is stored as JSON (`{"message": "..."}`) so it can be parsed back into a plain
// reason instead of showing the raw string to the user; a value that predates this shape or
// otherwise fails to parse is shown as-is rather than hidden.
function summarizeErrorDetail(errorDetail: string): string {
  try {
    const parsed = JSON.parse(errorDetail);
    return typeof parsed?.message === "string" ? parsed.message : errorDetail;
  } catch {
    return errorDetail;
  }
}

// A validate-only run never actually deploys anything, so its outcome is worded as a Validation,
// not a Deployment — matching the in-progress phase below, which already says "Validate action"
// rather than "Deploy action" for the same reason.
function statusMessage(status: string, validateOnly: boolean): string {
  const action = validateOnly ? "Validation" : "Deployment";
  switch (status) {
    case "validating":
      return "Validate action is in progress …";
    case "deploying":
      return "Deploy action is in progress …";
    case "succeeded":
      return `${action} succeeded`;
    case "failed":
      return `${action} failed`;
    case "cancelled":
      return `${action} cancelled`;
    case "rolled_back":
      return "Deployment rolled back";
    default:
      return status;
  }
}

export function DeploymentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
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

  // A pending deployment hasn't run yet, so there's nothing to report on — once it has, the
  // component editor stays up alongside a status panel and past-run results instead of being
  // replaced by a separate read-only view, so more components/types can always be picked and
  // Deploy/Validate clicked directly, without an extra "reopen for editing" step first.
  const isPending = deployment.status === "pending";
  const inProgress = IN_PROGRESS_STATUSES.has(deployment.status);
  // A validate-only run never touched the target, so "rolling it back" would be a real
  // destructive deploy against metadata the dry run never changed. A git target has no rollback
  // path at all (the original deployment was a commit). The backend rejects both; don't offer them.
  const canRollBack =
    deployment.status === "succeeded" && !deployment.validate_only && deployment.target_connection_type === "org";

  // The target's own configured minimum (see ConnectionDetail.tsx) — used only to color/label
  // this run's coverage result; the server already enforced the actual gate (see engine/deploy.ts).
  const targetMinCoverage = connections.find((c) => c.id === deployment.target_connection_id)?.minCodeCoveragePercent ?? null;
  const coverageBelowGate = targetMinCoverage != null && deployment.coverage_percent != null && deployment.coverage_percent < targetMinCoverage;
  const codeCoverage: { name: string; numLocations: number; numLocationsNotCovered: number }[] = deployment.coverage_details
    ? JSON.parse(deployment.coverage_details)
    : [];

  // Action-result errors stay outside the collapsible banner so collapsing it (once you've seen
  // the result) can never hide a Roll back/Cancel failure that needs attention.
  const statusErrors = (
    <>
      {rollbackError && <p role="alert">{rollbackError}</p>}
      {cancelError && <p role="alert">{cancelError}</p>}
      {pollError && <p role="alert">{pollError}</p>}
    </>
  );

  const statusPanel = isPending ? null : (
    <>
      {statusErrors}
      {/* A finished run (success or failure) defaults to collapsed — its outcome is summarized
          right in the always-visible summary line, so there's no need to re-expand it on every
          visit just to see what happened and when. Still open by default while in progress, so
          live status/progress is visible without an extra click. */}
      <details className={statusBannerClass(deployment.status)} open={inProgress}>
        <summary className="status-banner-message">
          {inProgress && <span className="spinner" role="status" aria-label="In progress" />}
          {statusMessage(deployment.status, !!deployment.validate_only)}
          <span className="status-banner-summary-time"> · Started {new Date(deployment.started_at).toLocaleString()}</span>
        </summary>
        <p>Status: {deployment.status}</p>
        <p>Test level: {deployment.test_level}</p>
        {deployment.validate_only ? <p>Validation only (dry run)</p> : null}
        {deployment.components_total !== null && (
          <ProgressBar label="Components" value={deployment.components_deployed ?? 0} max={deployment.components_total} />
        )}
        {deployment.test_level !== "NoTestRun" && deployment.tests_total !== null && (
          <ProgressBar label="Apex tests" value={deployment.tests_completed ?? 0} max={deployment.tests_total} />
        )}
        {deployment.coverage_percent !== null && (
          <p className={coverageBelowGate ? "status-label-danger" : "status-label-success"}>
            Code coverage: {deployment.coverage_percent.toFixed(1)}%
            {targetMinCoverage != null && ` (minimum ${targetMinCoverage}%)`}
          </p>
        )}
        {codeCoverage.length > 0 && (
          <details className="history-components">
            <summary>Per-class coverage</summary>
            <ul>
              {codeCoverage.map((c) => (
                <li key={c.name}>
                  {c.name}: {c.numLocations > 0 ? Math.round(((c.numLocations - c.numLocationsNotCovered) / c.numLocations) * 100) : 0}%
                </li>
              ))}
            </ul>
          </details>
        )}
        {deployment.run_by && <p className="status-banner-meta">Run by: {deployment.run_by}</p>}
        {deployment.error_detail && <p role="alert">{summarizeErrorDetail(deployment.error_detail)}</p>}
      </details>
    </>
  );

  const extraActions = (
    <>
      {inProgress && (
        <button type="button" onClick={handleCancel} disabled={cancelling}>
          Cancel
        </button>
      )}
      {canRollBack && <button onClick={handleRollback}>Roll back</button>}
    </>
  );

  return (
    <DeploymentEditor
      deploymentId={deployment.id}
      heading="Deployment"
      title={deployment.title}
      sourceId={deployment.source_connection_id}
      targetId={deployment.target_connection_id}
      connections={connections}
      initialComponents={deployment.components}
      initialTestLevel={deployment.test_level}
      initialValidateOnly={!!deployment.validate_only}
      initialIgnoreWarnings={!!deployment.ignore_warnings}
      initialAllowMissingFiles={!!deployment.allow_missing_files}
      initialAutoUpdatePackage={!!deployment.auto_update_package}
      initialRunTests={deployment.run_tests}
      autosaveEnabled={isPending}
      deployDisabled={inProgress}
      statusPanel={statusPanel}
      extraActions={extraActions}
      onDeploy={(payload) => (isPending ? runDeployment(deployment.id, payload) : rerunDeployment(deployment.id, payload))}
      onDeployed={(newId) => (newId === deployment.id ? setPollGeneration((g) => g + 1) : navigate(`/deployments/${newId}`))}
      onCloned={(newId) => navigate(`/deployments/${newId}`)}
      onDeleted={() => navigate("/deploy")}
    />
  );
}
