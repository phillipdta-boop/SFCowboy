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
import { nicknameFor, formatDate } from "../deploymentDisplay.js";
import { getDisplayName } from "../displayName.js";

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
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<number | null>(null);

  function refresh() {
    if (!runId) return;
    fetchPipelineRun(runId)
      .then(setRun)
      .catch((err) => setLoadError((err as Error).message));
  }

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);
  useEffect(refresh, [runId]);

  async function handleStep(stepIndex: number, validateOnly: boolean) {
    if (!runId) return;
    setActionError(null);
    setBusyStep(stepIndex);
    try {
      await deployPipelineStep(runId, stepIndex, { validateOnly, runBy: getDisplayName() || undefined });
      refresh();
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

      <ol className="pipeline-stepper">
        {run.connectionIds.map((connId, stageIndex) => (
          <li key={connId}>
            <div className="stage-name">{nicknameFor(connections, connId)}</div>
            {stageIndex < hopCount &&
              (() => {
                const eligible = run.positions.filter((p) => p.stage === stageIndex).length;
                const deployment = latestDeploymentForStep(run.deployments, stageIndex);
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
                    <button type="button" onClick={() => handleStep(stageIndex, true)} disabled={eligible === 0 || busyStep === stageIndex}>
                      Validate
                    </button>
                    <button type="button" onClick={() => handleStep(stageIndex, false)} disabled={eligible === 0 || busyStep === stageIndex}>
                      Deploy
                    </button>
                  </div>
                );
              })()}
          </li>
        ))}
      </ol>

      {/* Column headers repeat the same nicknames the stepper above already shows "across the
          top" — visible duplicate text would make every nickname ambiguous to find on the page
          (and to a screen reader traversing top-to-bottom), so each header column carries the
          connection's name as an accessible label instead of a second visible copy. The columns
          line up 1:1 with the stepper's stages directly above. */}
      <table>
        <thead>
          <tr>
            <th>Component</th>
            {run.connectionIds.map((connId) => (
              <th key={connId} aria-label={nicknameFor(connections, connId)} />
            ))}
          </tr>
        </thead>
        <tbody>
          {run.componentList.map((component) => {
            const position = run.positions.find((p) => componentKey(p) === componentKey(component))!;
            return (
              <tr key={componentKey(component)}>
                <td>
                  {component.type} {component.fullName}
                </td>
                {run.connectionIds.map((_, columnIndex) => {
                  const state = cellState(position, columnIndex, component, run.deployments);
                  return (
                    <td key={columnIndex} data-testid={`cell-${componentKey(component)}-${columnIndex}`}>
                      {state === "done" && <span title={position.reachedAt ?? undefined}>✓</span>}
                      {state === "failed" && <span>✗</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
