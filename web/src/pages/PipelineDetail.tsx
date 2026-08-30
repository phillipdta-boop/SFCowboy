import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type Pipeline,
  type ConnectionSummary,
  type PipelineRunSummary,
  type DiffItem,
  fetchPipeline,
  fetchConnections,
  fetchPipelineRuns,
  createPipelineRun,
  updatePipeline,
  fetchMetadataTypes,
  fetchDiff,
} from "../api/client.js";
import { DiffTable, diffItemKey } from "../components/DiffTable.js";
import { MetadataTypeSelector } from "../components/MetadataTypeSelector.js";
import { OBJECTS_AND_CHILD_COMPONENTS, expandTypeSelection } from "../metadataTypeGroups.js";
import { nicknameFor, formatDate } from "../deploymentDisplay.js";

type Tab = "runs" | "settings";

export function PipelineDetail() {
  const { id } = useParams<{ id: string }>();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [runs, setRuns] = useState<PipelineRunSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("runs");

  const [creatingRun, setCreatingRun] = useState(false);
  const [runTitle, setRunTitle] = useState("");
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runError, setRunError] = useState<string | null>(null);

  const [settingsName, setSettingsName] = useState("");
  const [trackIndependently, setTrackIndependently] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  function refresh() {
    if (!id) return;
    fetchPipeline(id)
      .then((p) => {
        setPipeline(p);
        setSettingsName(p.name);
        setTrackIndependently(p.trackComponentsIndependently);
      })
      .catch((err) => setLoadError((err as Error).message));
    fetchConnections()
      .then(setConnections)
      .catch((err) => setLoadError((err as Error).message));
    fetchPipelineRuns(id)
      .then(setRuns)
      .catch((err) => setLoadError((err as Error).message));
  }

  useEffect(refresh, [id]);

  async function openNewRun() {
    setCreatingRun(true);
    setRunError(null);
    setDiffItems([]);
    setSelected(new Set());
    setSelectedTypes(new Set());
    setRunTitle("");

    // A metadata-type describe (a git clone/fetch, for a git-backed first stage) is slow enough
    // that merely opening a pipeline's page shouldn't pay for it — only the picker that needs the
    // list does, and only the first time it's opened.
    if (availableTypes.length > 0 || !pipeline || pipeline.connectionIds.length === 0) return;
    try {
      setAvailableTypes(await fetchMetadataTypes(pipeline.connectionIds[0]));
    } catch (err) {
      setRunError((err as Error).message);
    }
  }

  async function handleLoadDiff() {
    if (!pipeline) return;
    setDiffLoading(true);
    setRunError(null);
    try {
      const items = await fetchDiff(pipeline.connectionIds[0], pipeline.connectionIds[1], expandTypeSelection(selectedTypes));
      setDiffItems(items);
      // Start with nothing selected — the user picks which components to include in the run
      // (unlike the deployment editor's diff view, which pre-checks added/modified items).
      setSelected(new Set());
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setDiffLoading(false);
    }
  }

  async function handleStartRun() {
    if (!id) return;
    setRunError(null);
    const components = diffItems.filter((item) => selected.has(diffItemKey(item))).map((item) => ({ type: item.type, fullName: item.fullName }));
    try {
      const { id: runId } = await createPipelineRun(id, { title: runTitle.trim() || undefined, components });
      setCreatingRun(false);
      refresh();
      // Nothing further to do here client-side — the Runs list link below takes the user to the
      // freshly created run once `refresh()` resolves. (Task 12 makes /pipelines/:id/runs/:runId
      // a real page; navigating there immediately is left as a follow-up polish, not required by
      // any test in this task.)
      void runId;
    } catch (err) {
      setRunError((err as Error).message);
    }
  }

  async function handleSaveSettings() {
    if (!id || !pipeline) return;
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const updated = await updatePipeline(id, {
        name: settingsName,
        connectionIds: pipeline.connectionIds,
        trackComponentsIndependently: trackIndependently,
      });
      setPipeline(updated);
      setSettingsSaved(true);
    } catch (err) {
      setSettingsError((err as Error).message);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!pipeline) return <p>Loading…</p>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/pipelines">Pipelines</Link>
        <span aria-hidden="true"> › </span>
        <span>{pipeline.name}</span>
      </nav>

      <h1>{pipeline.name}</h1>
      <p className="pipeline-stages">
        {pipeline.connectionIds.map((connId, i) => (
          <span key={connId}>
            {i > 0 && <span aria-hidden="true"> → </span>}
            {nicknameFor(connections, connId)}
          </span>
        ))}
      </p>

      <div role="tablist">
        <button type="button" role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>
          Runs
        </button>
        <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "runs" && (
        <div>
          {runError && <p role="alert">{runError}</p>}
          {!creatingRun && (
            <>
              <button type="button" onClick={openNewRun} disabled={pipeline.connectionIds.length < 2}>
                New Run
              </button>
              <ul>
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link to={`/pipelines/${pipeline.id}/runs/${r.id}`}>{r.title ?? formatDate(r.createdAt)}</Link>{" "}
                    <span>
                      {r.componentsAtFinalStage} / {r.componentCount} at final stage
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {creatingRun && (
            <div>
              <label>
                Run title (optional)
                <input value={runTitle} onChange={(e) => setRunTitle(e.target.value)} />
              </label>
              <h2>Component Types</h2>
              <MetadataTypeSelector
                types={[OBJECTS_AND_CHILD_COMPONENTS, ...availableTypes]}
                selected={selectedTypes}
                onToggle={(type) =>
                  setSelectedTypes((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  })
                }
                onSelectAll={() => setSelectedTypes(new Set([OBJECTS_AND_CHILD_COMPONENTS, ...availableTypes]))}
                onSelectNone={() => setSelectedTypes(new Set())}
              />
              <button onClick={handleLoadDiff} disabled={selectedTypes.size === 0 || diffLoading}>
                {diffLoading ? "Loading…" : "Load Diff"}
              </button>
              {diffItems.length > 0 && <DiffTable items={diffItems} selected={selected} onToggle={(key) => setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })} />}
              <div className="form-actions">
                <button type="button" onClick={handleStartRun} disabled={selected.size === 0}>
                  Start run
                </button>
                <button type="button" onClick={() => setCreatingRun(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div>
          {settingsError && <p role="alert">{settingsError}</p>}
          {settingsSaved && <p role="status">Saved.</p>}
          <label>
            Name
            <input
              value={settingsName}
              onChange={(e) => {
                setSettingsName(e.target.value);
                setSettingsSaved(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={trackIndependently}
              onChange={(e) => {
                setTrackIndependently(e.target.checked);
                setSettingsSaved(false);
              }}
            />
            Track components independently
          </label>
          <div className="form-actions">
            <button type="button" onClick={handleSaveSettings}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
