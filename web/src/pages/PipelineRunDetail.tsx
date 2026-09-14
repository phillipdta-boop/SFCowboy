import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  type PipelineRunDetail as PipelineRunDetailType,
  type PipelineStepDeployment,
  type TestLevel,
  fetchConnections,
  fetchPipelineRun,
  deployPipelineStep,
  updatePipelineRunTitle,
} from "../api/client.js";
import { StatusBadge, STATUS_COLOR_CLASS } from "../components/StatusBadge.js";
import { nicknameFor, formatDate, componentPath } from "../deploymentDisplay.js";
import { TableFilterRow } from "../components/TableFilterRow.js";
import { Loader } from "../components/Loader.js";
import { Modal } from "../components/Modal.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";
import { useCowboyMode } from "../useCowboyMode.js";
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

// Same knobs DeploymentEditor's own Options tab exposes for a manual deployment -- kept per hop
// (rather than one shared set for the whole run) since different hops can reasonably want
// different test levels, e.g. skipping tests into a sandbox but requiring them into production.
interface StepDeployOptions {
  testLevel: TestLevel;
  ignoreWarnings: boolean;
  allowMissingFiles: boolean;
  autoUpdatePackage: boolean;
  runTestsInput: string;
}

const DEFAULT_STEP_OPTIONS: StepDeployOptions = {
  testLevel: "NoTestRun",
  ignoreWarnings: false,
  allowMissingFiles: false,
  autoUpdatePackage: false,
  runTestsInput: "",
};

function cellState(
  position: { stage: number },
  columnIndex: number,
  component: { type: string; fullName: string },
  deployments: PipelineStepDeployment[],
  // The last column has no hop STARTING from it (hop stepIndex only goes up to hopCount - 1), so
  // a component that has reached it (position.stage === hopCount) has nothing left that could
  // fail -- it must be marked done outright rather than falling through to the "look up the hop
  // starting here" branch below, which would never find one and left the final column blank
  // forever even after a real, successful deploy all the way to it.
  hopCount: number
): CellState {
  if (position.stage > columnIndex) return "done";
  if (position.stage === columnIndex && columnIndex === hopCount) return "done";
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
  const [quickDeploying, setQuickDeploying] = useState(false);
  const [quickDeployConfirmOpen, setQuickDeployConfirmOpen] = useState(false);
  const cowboyMode = useCowboyMode();

  // Per-hop deploy options (test level, warnings/missing-files/auto-update flags, specified
  // tests) -- same shape DeploymentEditor's Options tab collects, just keyed by stepIndex since
  // this page has one Validate/Deploy pair per hop rather than a single one for the whole page.
  const [stepOptions, setStepOptions] = useState<Record<number, StepDeployOptions>>({});
  const [openOptionsStep, setOpenOptionsStep] = useState<number | null>(null);

  function getStepOptions(stepIndex: number): StepDeployOptions {
    return stepOptions[stepIndex] ?? DEFAULT_STEP_OPTIONS;
  }

  function updateStepOptions(stepIndex: number, patch: Partial<StepDeployOptions>) {
    setStepOptions((prev) => ({ ...prev, [stepIndex]: { ...getStepOptions(stepIndex), ...patch } }));
  }
  // Only the Component column has free text worth searching — the per-stage columns are just
  // ✓/✗ glyphs, not something a filter box would usefully match against.
  const [componentFilter, setComponentFilter] = useState("");

  // Self-contained edit-toggle for the run's title, mirroring DeploymentActions.tsx's pattern —
  // not shared as a component since this page is the only place a run's title is editable and
  // the surrounding markup (an <h1>, not a button row) differs enough that sharing would just
  // add an interface to thread through rather than remove duplication.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleBusy, setTitleBusy] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);

  function startEditingTitle() {
    setTitleDraft(run?.title ?? "");
    setTitleError(null);
    setEditingTitle(true);
  }

  async function handleSaveTitle() {
    if (!runId) return;
    setTitleBusy(true);
    setTitleError(null);
    try {
      const next = titleDraft.trim() || null;
      await updatePipelineRunTitle(runId, next);
      setRun((prev) => (prev ? { ...prev, title: next } : prev));
      setEditingTitle(false);
    } catch (err) {
      setTitleError((err as Error).message);
    } finally {
      setTitleBusy(false);
    }
  }

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
      const opts = getStepOptions(stepIndex);
      const runTests = opts.runTestsInput
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      await deployPipelineStep(runId, stepIndex, {
        validateOnly,
        testLevel: opts.testLevel,
        ignoreWarnings: opts.ignoreWarnings,
        allowMissingFiles: opts.allowMissingFiles,
        autoUpdatePackage: opts.autoUpdatePackage,
        runTests: opts.testLevel === "RunSpecifiedTests" ? runTests : undefined,
      });
      setPollGeneration((g) => g + 1);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyStep(null);
    }
  }

  // Cowboy Mode's "run to completion" button: walks every hop of this run in sequence, using the
  // same deployPipelineStep call (and the same server-side safety gates, e.g. coverage gates) each
  // manual Deploy click already goes through -- this only removes the wait-and-click-again friction
  // between hops. Stops immediately if a hop doesn't succeed, rather than deploying further
  // environments on top of a failure. Self-contained (its own poll loop) rather than reusing the
  // page's background poll effect, so there's one place watching for this run's completion instead
  // of two effects racing to interpret the same state.
  async function confirmQuickDeploy() {
    if (!runId || !run) return;
    setQuickDeployConfirmOpen(false);
    setActionError(null);
    setQuickDeploying(true);
    try {
      for (let stage = 0; stage < hopCount; stage++) {
        let current = await fetchPipelineRun(runId);
        if (current.positions.filter((p) => p.stage === stage).length === 0) continue;

        await deployPipelineStep(runId, stage, { validateOnly: false });

        let deployment: PipelineStepDeployment | undefined;
        for (;;) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          current = await fetchPipelineRun(runId);
          setRun(current);
          deployment = latestDeploymentForStep(current.deployments, stage);
          if (deployment && TERMINAL_STATUSES.has(deployment.status)) break;
        }
        if (deployment.status !== "succeeded") {
          const from = nicknameFor(connections, run.connectionIds[stage]);
          const to = nicknameFor(connections, run.connectionIds[stage + 1]);
          setActionError(`Quick Deploy stopped: ${from} → ${to} ${deployment.status}.`);
          return;
        }
      }
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setQuickDeploying(false);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!run) return <Loader />;

  const hopCount = run.connectionIds.length - 1;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to={`/pipelines/${run.pipelineId}`}>Pipeline</Link>
        <span aria-hidden="true"> › </span>
        <span>{run.title ?? formatDate(run.createdAt)}</span>
      </nav>

      <div className="page-heading-row">
        {editingTitle ? (
          <div className="run-title-edit">
            <input
              aria-label="Run title"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              placeholder="run title ..."
              autoFocus
            />
            <button type="button" onClick={handleSaveTitle} disabled={titleBusy}>
              Save
            </button>
            <button type="button" onClick={() => setEditingTitle(false)} disabled={titleBusy}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="run-title-display">
            <h1>{cowboyMode && "🤠 "}{run.title ?? formatDate(run.createdAt)}</h1>
            <button type="button" onClick={startEditingTitle}>
              Rename
            </button>
          </div>
        )}
        {cowboyMode && (
          <button
            type="button"
            className="quick-deploy-button"
            onClick={() => setQuickDeployConfirmOpen(true)}
            disabled={quickDeploying || busyStep !== null}
          >
            {quickDeploying ? "Quick Deploying…" : "🤠 Quick Deploy"}
          </button>
        )}
      </div>
      {titleError && <p role="alert">{titleError}</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {pollError && <p role="alert">{pollError}</p>}

      {quickDeployConfirmOpen && (
        <Modal title="Quick Deploy" onClose={() => setQuickDeployConfirmOpen(false)}>
          <p>Quick Deploy will run this pipeline through every environment automatically:</p>
          <p className="quick-deploy-env-chain">{run.connectionIds.map((connId) => nicknameFor(connections, connId)).join(" → ")}</p>
          <div className="form-actions">
            <button type="button" onClick={confirmQuickDeploy}>
              Continue
            </button>
            <button type="button" onClick={() => setQuickDeployConfirmOpen(false)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {/* Vertical rather than horizontal so a pipeline with many stages grows down the page
          instead of overflowing sideways -- each connector's own color and subtext report that
          hop's live deploy status, not just the stage names either side of it. */}
      <ol className="pipeline-vstepper">
        {run.connectionIds.map((connId, stageIndex) => {
          const connection = connections.find((c) => c.id === connId);
          return (
            <Fragment key={connId}>
              <li className="vstepper-node">
                <span className="vstepper-node-icon">
                  <ConnectionTypeIcon type={connection?.type ?? "org"} />
                </span>
                <span className="vstepper-node-name">{nicknameFor(connections, connId)}</span>
              </li>
              {stageIndex < hopCount &&
                (() => {
                  const eligible = run.positions.filter((p) => p.stage === stageIndex).length;
                  const deployment = latestDeploymentForStep(run.deployments, stageIndex);
                  // busyStep only covers the request itself, which returns while the hop is still
                  // deploying — the server rejects a second concurrent deploy for the same step, so
                  // don't offer one either.
                  const inFlight = !!deployment && !TERMINAL_STATUSES.has(deployment.status);
                  const hopBusy = busyStep === stageIndex || inFlight || quickDeploying;
                  const colorClass = deployment ? STATUS_COLOR_CLASS[deployment.status] ?? "status-label-muted" : "status-label-muted";
                  return (
                    <li className={`vstepper-connector ${colorClass}`}>
                      <span className="vstepper-connector-arrow" aria-hidden="true" />
                      <div className="vstepper-connector-body">
                        {deployment ? (
                          <>
                            <StatusBadge status={deployment.status} />
                            {deployment.finishedAt && <span className="hop-timestamp">{formatDate(deployment.finishedAt)}</span>}
                            <Link to={`/deployments/${deployment.id}`}>View deployment</Link>
                          </>
                        ) : (
                          <span className="hop-timestamp">Not started</span>
                        )}
                        <div className="vstepper-connector-actions">
                          <button type="button" onClick={() => handleStep(stageIndex, true)} disabled={eligible === 0 || hopBusy}>
                            Validate
                          </button>
                          <button type="button" onClick={() => handleStep(stageIndex, false)} disabled={eligible === 0 || hopBusy}>
                            Deploy
                          </button>
                          <button
                            type="button"
                            className="step-options-toggle"
                            onClick={() => setOpenOptionsStep(openOptionsStep === stageIndex ? null : stageIndex)}
                            aria-expanded={openOptionsStep === stageIndex}
                          >
                            Options
                          </button>
                        </div>
                        {openOptionsStep === stageIndex &&
                          (() => {
                            const opts = getStepOptions(stageIndex);
                            return (
                              <div className="deploy-options-panel step-options-panel">
                                <label>
                                  Test level
                                  <select
                                    value={opts.testLevel}
                                    onChange={(e) => updateStepOptions(stageIndex, { testLevel: e.target.value as TestLevel })}
                                  >
                                    <option value="NoTestRun">No Test Run</option>
                                    <option value="RunSpecifiedTests">Run Specified Tests</option>
                                    <option value="RunLocalTests">Run Local Tests</option>
                                    <option value="RunAllTestsInOrg">Run All Tests In Org</option>
                                  </select>
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={opts.ignoreWarnings}
                                    onChange={(e) => updateStepOptions(stageIndex, { ignoreWarnings: e.target.checked })}
                                  />
                                  Ignore warnings
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={opts.allowMissingFiles}
                                    onChange={(e) => updateStepOptions(stageIndex, { allowMissingFiles: e.target.checked })}
                                  />
                                  Allow missing components
                                </label>
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={opts.autoUpdatePackage}
                                    onChange={(e) => updateStepOptions(stageIndex, { autoUpdatePackage: e.target.checked })}
                                  />
                                  Auto update package
                                </label>
                                {opts.testLevel === "RunSpecifiedTests" && (
                                  <label>
                                    Select Tests
                                    <textarea
                                      value={opts.runTestsInput}
                                      onChange={(e) => updateStepOptions(stageIndex, { runTestsInput: e.target.value })}
                                      placeholder="names of test classes in a comma-separated list"
                                    />
                                  </label>
                                )}
                              </div>
                            );
                          })()}
                      </div>
                    </li>
                  );
                })()}
            </Fragment>
          );
        })}
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
                      const state = cellState(position, columnIndex, component, run.deployments, hopCount);
                      return (
                        <td key={columnIndex} data-testid={`cell-${componentKey(component)}-${columnIndex}`}>
                          {state === "done" && (
                            <span className="cell-status-dot cell-status-dot-success" aria-label="Done" title={position.reachedAt ?? undefined}>
                              ✓
                            </span>
                          )}
                          {state === "failed" && (
                            <span className="cell-status-dot cell-status-dot-danger" aria-label="Failed">
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
