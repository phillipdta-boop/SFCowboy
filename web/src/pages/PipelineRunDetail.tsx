import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  type PipelineRunDetail as PipelineRunDetailType,
  type PipelineStepDeployment,
  fetchConnections,
  fetchPipelineRun,
  deployPipelineStep,
} from "../api/client.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { nicknameFor, formatDate, componentPath } from "../deploymentDisplay.js";
import { getDisplayName } from "../displayName.js";
import { TableFilterRow } from "../components/TableFilterRow.js";
import { matchesFilter } from "../tableFilter.js";

// Mirrors DeploymentDetail.tsx's TERMINAL_STATUSES — the states a deployment never leaves.
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rolled_back", "cancelled"]);

function componentKey(c: { type: string; fullName: string }): string {
  return `${c.type}::${c.fullName}`;
}

// The deployment (if any) most recently tagged to this hop — later start time wins among however
// many attempts/retries have been tagged to the same step.
function latestDeploymentForStep(deployments: PipelineStepDeployment[], stepIndex: number): PipelineStepDeployment | undefined {
  return deployments
    .filter((d) => d.stepIndex === stepIndex)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
}

type CellState = "done" | "failed" | "pending";

function cellState(
  position: { stage: number },
  columnIndex: number,
  component: { type: string; fullName: string },
  deployments: PipelineStepDeployment[]
): CellState {
  if (position.stage > columnIndex) return "done";
  if (position.stage !== columnIndex) return "pending";
  const attempt = latestDeploymentForStep(deployments, columnIndex);
  if (!attempt) return "pending";
  const item = attempt.items.find((i) => `${i.metadataType}::${i.apiName}` === componentKey(component));
  return item?.status === "failed" ? "failed" : "pending";
}

export function PipelineRunDetail() {
  const { runId } = useParams<{ pipelineId: string; runId: string }>();
  const [run, setRun] = useState<PipelineRunDetailType | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<number | null>(null);
  // Bumped after a hop is validated/deployed, to restart the poll loop below now that there's a
  // fresh in-progress deployment to watch.
  const [pollGeneration, setPollGeneration] = useState(0);
  // Only the Component column has free text worth searching — the per-stage columns are just
  // ✓/✗ glyphs, not something a filter box would usefully match against.
  const [componentFilter, setComponentFilter] = useState("");

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Tracks whether the run has ever loaded, independent of React state (which this closure's
    // later invocations wouldn't see) — see DeploymentDetail.tsx's poll loop for the same reasoning.
    let hasLoadedOnce = false;

    async function poll() {
      try {
        const detail = await fetchPipelineRun(runId!);
        if (cancelled) return;
        hasLoadedOnce = true;
        setRun(detail);
        setPollError(null);
        // The deploy endpoint answers as soon as the hop is queued, so its deployment is still
        // running when the response lands — the stepper and grid only stay current by re-reading.
        if (detail.deployments.some((d) => !TERMINAL_STATUSES.has(d.status))) {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (cancelled) return;
        if (hasLoadedOnce) {
          // A later poll failed with the run already on screen: show the error without hiding the
          // view, and keep polling so it can recover on its own.
          setPollError((err as Error).message);
          timer = setTimeout(poll, 2000);
        } else {
          setLoadError((err as Error).message);
        }
      }
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [runId, pollGeneration]);

  async function handleStep(stepIndex: number, validateOnly: boolean) {
    if (!runId) return;
    setActionError(null);
    setBusyStep(stepIndex);
    try {
      await deployPipelineStep(runId, stepIndex, { validateOnly, runBy: getDisplayName() || undefined });
      setPollGeneration((g) => g + 1);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyStep(null);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!run) return <p>Loading…</p>;

  const hopCount = run.connectionIds.length - 1;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to={`/pipelines/${run.pipelineId}`}>Pipeline</Link>
        <span aria-hidden="true"> › </span>
        <span>{run.title ?? formatDate(run.createdAt)}</span>
      </nav>

      <h1>{run.title ?? formatDate(run.createdAt)}</h1>
      {actionError && <p role="alert">{actionError}</p>}
      {pollError && <p role="alert">{pollError}</p>}

      <ol className="pipeline-stepper">
        {run.connectionIds.map((connId, stageIndex) => (
          <li key={connId}>
            <div className="stage-name">{nicknameFor(connections, connId)}</div>
            {stageIndex < hopCount &&
              (() => {
                const eligible = run.positions.filter((p) => p.stage === stageIndex).length;
                const deployment = latestDeploymentForStep(run.deployments, stageIndex);
                // busyStep only covers the request itself, which returns while the hop is still
                // deploying — the server rejects a second concurrent deploy for the same step, so
                // don't offer one either.
                const inFlight = !!deployment && !TERMINAL_STATUSES.has(deployment.status);
                const hopBusy = busyStep === stageIndex || inFlight;
                return (
                  <div className="hop">
                    {deployment ? (
                      <>
                        <StatusBadge status={deployment.status} />
                        {deployment.finishedAt && <span className="hop-timestamp">{formatDate(deployment.finishedAt)}</span>}
                        <Link to={`/deployments/${deployment.id}`}>View deployment</Link>
                      </>
                    ) : (
                      <span className="hop-timestamp">Not started</span>
                    )}
                    <button type="button" onClick={() => handleStep(stageIndex, true)} disabled={eligible === 0 || hopBusy}>
                      Validate
                    </button>
                    <button type="button" onClick={() => handleStep(stageIndex, false)} disabled={eligible === 0 || hopBusy}>
                      Deploy
                    </button>
                  </div>
                );
              })()}
          </li>
        ))}
      </ol>

      <p>✓ marks a component that has reached this stage; ✗ marks one that failed here.</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Component</th>
              {run.connectionIds.map((connId) => (
                <th key={connId}>{nicknameFor(connections, connId)}</th>
              ))}
            </tr>
            <TableFilterRow
              columns={[{ key: "component", label: "component" }, ...run.connectionIds.map((connId) => ({ key: connId }))]}
              filters={{ component: componentFilter }}
              onChange={(_key, value) => setComponentFilter(value)}
            />
          </thead>
          <tbody>
            {run.componentList
              .filter((component) => matchesFilter(componentPath(component.type, component.fullName), componentFilter))
              .map((component) => {
                const position = run.positions.find((p) => componentKey(p) === componentKey(component))!;
                return (
                  <tr key={componentKey(component)}>
                    <td>{componentPath(component.type, component.fullName)}</td>
                    {run.connectionIds.map((_, columnIndex) => {
                      const state = cellState(position, columnIndex, component, run.deployments);
                      return (
                        <td key={columnIndex} data-testid={`cell-${componentKey(component)}-${columnIndex}`}>
                          {state === "done" && (
                            <span className="status-label-success" aria-label="Done" title={position.reachedAt ?? undefined}>
                              ✓
                            </span>
                          )}
                          {state === "failed" && (
                            <span className="status-label-danger" aria-label="Failed">
                              ✗
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
