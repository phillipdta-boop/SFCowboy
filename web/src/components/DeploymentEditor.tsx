import { useEffect, useState, type ReactNode } from "react";
import {
  type ConnectionSummary,
  type DiffItem,
  type TestLevel,
  type DeployComponentSelection,
  type DeployRunOptions,
  fetchMetadataTypes,
  fetchDiff,
  saveDeploymentComponents,
} from "../api/client.js";
import { DiffTable, diffItemKey } from "./DiffTable.js";
import { MetadataTypeSelector } from "./MetadataTypeSelector.js";
import { DeploymentActions } from "./DeploymentActions.js";
import { OBJECTS_AND_CHILD_COMPONENTS, expandTypeSelection } from "../metadataTypeGroups.js";
import { nicknameFor } from "../deploymentDisplay.js";
import { EnvironmentSummary } from "./EnvironmentSummary.js";

function actionForStatus(status: DiffItem["status"]): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

function componentKey(c: { type: string; fullName: string }): string {
  return `${c.type}::${c.fullName}`;
}

export interface DeploymentEditorProps {
  deploymentId: string;
  heading: string;
  title: string | null;
  sourceId: string;
  targetId: string;
  connections: ConnectionSummary[];
  // Components already attached to this deployment (e.g. re-opening a saved-but-not-yet-run
  // draft). When present, the diff pre-selects exactly these instead of the added/modified
  // default, so the user sees what they already picked rather than a fresh heuristic guess.
  initialComponents?: DeployComponentSelection[];
  // Deploy Options already attached to this deployment (e.g. re-opening a draft, or a fresh
  // clone from Deploy again/Validate again) — carried over so reopening doesn't silently reset
  // a Run Specified Tests list or a Validate-only intent back to the defaults.
  initialTestLevel?: TestLevel;
  initialValidateOnly?: boolean;
  initialIgnoreWarnings?: boolean;
  initialAllowMissingFiles?: boolean;
  initialAutoUpdatePackage?: boolean;
  initialRunTests?: string[];
  // Whether component/option edits autosave to the draft as the user picks — only valid while
  // the underlying deployment is still pending (the backend rejects saving once it has run).
  // Defaults to true, matching the New Deployment / reopened-pending-draft cases.
  autosaveEnabled?: boolean;
  // Disables the Deploy/Validate buttons for a reason external to the current selection — e.g.
  // a previous run of this same deployment is still in progress.
  deployDisabled?: boolean;
  // Extra content rendered between the heading and the metadata type picker — e.g. a live status
  // banner and past-run results for a deployment that has already run before.
  statusPanel?: ReactNode;
  // Extra buttons rendered in the toolbar alongside Clone/Edit/Delete — e.g. Cancel or Roll back.
  extraActions?: ReactNode;
  // Performs the actual deploy/validate call — the caller decides whether that's running this
  // same deployment in place (still pending) or cloning it into a new run (already finished).
  onDeploy: (payload: DeployRunOptions) => Promise<{ id: string }>;
  // Called with whatever id onDeploy's call actually ran — the same deploymentId when run in
  // place, or a freshly cloned id when re-running a finished deployment.
  onDeployed: (deploymentId: string) => void;
  onCloned: (newDeploymentId: string) => void;
  onDeleted: () => void;
}

/**
 * The component-picking half of the deployment flow: choose metadata types, load the org/git
 * diff, select what to include, and run it. Shared by the New Deployment page (a brand-new
 * draft) and the deployment detail page (re-opening a pending draft to keep adding to it).
 */
export function DeploymentEditor({
  deploymentId,
  heading,
  title,
  sourceId,
  targetId,
  connections,
  initialComponents,
  initialTestLevel,
  initialValidateOnly,
  initialIgnoreWarnings,
  initialAllowMissingFiles,
  initialAutoUpdatePackage,
  initialRunTests,
  autosaveEnabled = true,
  deployDisabled = false,
  statusPanel,
  extraActions,
  onDeploy,
  onDeployed,
  onCloned,
  onDeleted,
}: DeploymentEditorProps) {
  const [currentTitle, setCurrentTitle] = useState(title);
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"all" | "selected" | "options">("all");
  const [testLevel, setTestLevel] = useState<TestLevel>("NoTestRun");
  const [validateOnly, setValidateOnly] = useState(false);
  // Passed straight through to Salesforce's Metadata API deploy() call.
  const [ignoreWarnings, setIgnoreWarnings] = useState(false);
  const [allowMissingFiles, setAllowMissingFiles] = useState(false);
  const [autoUpdatePackage, setAutoUpdatePackage] = useState(false);
  // Raw comma-separated text as the user types it; parsed into the array Salesforce expects
  // only at save/deploy time so a trailing comma or extra space mid-edit doesn't get mangled.
  const [runTestsInput, setRunTestsInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const runTests = runTestsInput
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const missingRequiredTests = testLevel === "RunSpecifiedTests" && runTests.length === 0;

  useEffect(() => {
    setAvailableTypes([]);
    setDiffItems([]);
    setError(null);
    setCurrentTitle(title);
    setTestLevel(initialTestLevel ?? "NoTestRun");
    setValidateOnly(initialValidateOnly ?? false);
    setIgnoreWarnings(initialIgnoreWarnings ?? false);
    setAllowMissingFiles(initialAllowMissingFiles ?? false);
    setAutoUpdatePackage(initialAutoUpdatePackage ?? false);
    setRunTestsInput((initialRunTests ?? []).join(", "));

    // Re-opening a draft that already has components: restore the type filter they implied and
    // load the diff right away, so the user sees their previous selection instead of a blank
    // picker they'd have to redo from scratch.
    const initialTypes = new Set((initialComponents ?? []).map((c) => c.type));
    setSelectedTypes(initialTypes);

    fetchMetadataTypes(sourceId)
      .then((types) => {
        setAvailableTypes(types);
      })
      .catch((err) => setError((err as Error).message));

    if (initialTypes.size > 0) {
      loadDiff(initialTypes);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  function toggleType(type: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function loadDiff(types: Set<string>) {
    setError(null);
    setDiffLoading(true);
    try {
      const items = await fetchDiff(sourceId, targetId, expandTypeSelection(types));
      setDiffItems(items);
      const existingKeys = new Set((initialComponents ?? []).map(componentKey));
      if (existingKeys.size > 0) {
        setSelected(new Set(items.filter((i) => existingKeys.has(componentKey(i))).map(diffItemKey)));
      } else {
        setSelected(new Set(items.filter((i) => i.status === "added" || i.status === "modified").map(diffItemKey)));
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiffLoading(false);
    }
  }

  function handleLoadDiff() {
    return loadDiff(selectedTypes);
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Autosaves the current component selection to the draft so it survives navigating away and
  // back, without running the deployment. Debounced so rapid checkbox toggling doesn't fire a
  // request per click.
  useEffect(() => {
    if (!autosaveEnabled) return;
    if (diffItems.length === 0) return;
    const components: DeployComponentSelection[] = diffItems
      .filter((item) => selected.has(diffItemKey(item)))
      .map((item) => ({ type: item.type, fullName: item.fullName, action: actionForStatus(item.status) }));

    const timer = setTimeout(() => {
      saveDeploymentComponents(deploymentId, {
        components,
        testLevel,
        validateOnly,
        ignoreWarnings,
        allowMissingFiles,
        autoUpdatePackage,
        runTests,
      }).catch((err) => {
        setError((err as Error).message);
      });
    }, 500);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autosaveEnabled, deploymentId, diffItems, selected, testLevel, validateOnly, ignoreWarnings, allowMissingFiles, autoUpdatePackage, runTestsInput]);

  // The toolbar's Validate/Deploy buttons always run as their name says, regardless of the
  // "Validate only" checkbox below the table; the checkbox only drives the plain Deploy button
  // down there. Passing no override runs with whatever the checkbox is currently set to.
  async function handleDeploy(overrideValidateOnly?: boolean) {
    setError(null);
    const components: DeployComponentSelection[] = diffItems
      .filter((item) => selected.has(diffItemKey(item)))
      .map((item) => ({ type: item.type, fullName: item.fullName, action: actionForStatus(item.status) }));

    try {
      const { id } = await onDeploy({
        components,
        testLevel,
        validateOnly: overrideValidateOnly ?? validateOnly,
        ignoreWarnings,
        allowMissingFiles,
        autoUpdatePackage,
        runTests,
      });
      onDeployed(id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>
        {heading}: {currentTitle || `${nicknameFor(connections, sourceId)} → ${nicknameFor(connections, targetId)}`}
      </h1>
      <EnvironmentSummary connections={connections} sourceId={sourceId} targetId={targetId} />

      {/* Mirrors the Validate/Deploy buttons below the table so running either doesn't require
          scrolling all the way down past a long component list. */}
      <div className="deployment-toolbar">
        <button
          type="button"
          onClick={() => handleDeploy(true)}
          disabled={selected.size === 0 || missingRequiredTests || deployDisabled}
        >
          Validate
        </button>
        <button
          type="button"
          onClick={() => handleDeploy(false)}
          disabled={selected.size === 0 || missingRequiredTests || deployDisabled}
        >
          Deploy
        </button>
        {extraActions}
        <DeploymentActions
          deploymentId={deploymentId}
          title={currentTitle}
          onTitleChange={setCurrentTitle}
          onCloned={onCloned}
          onDeleted={onDeleted}
        />
      </div>

      {error && <p role="alert">{error}</p>}
      {statusPanel}

      {availableTypes.length > 0 && (
        <>
          <h2>Component Types</h2>
          <MetadataTypeSelector
            types={[OBJECTS_AND_CHILD_COMPONENTS, ...availableTypes]}
            selected={selectedTypes}
            onToggle={toggleType}
            onSelectAll={() => setSelectedTypes(new Set([OBJECTS_AND_CHILD_COMPONENTS, ...availableTypes]))}
            onSelectNone={() => setSelectedTypes(new Set())}
          />
          <button onClick={handleLoadDiff} disabled={selectedTypes.size === 0 || diffLoading}>
            {diffLoading ? "Loading…" : "Load Diff"}
          </button>
        </>
      )}

      {/* Permanent so the page doesn't jump around as the diff loads: empty while there's
          nothing to show yet, a spinner while it's loading, the real table once it's ready. */}
      <div className="diff-results">
        {diffLoading ? (
          <div className="spinner" role="status" aria-label="Loading diff…" />
        ) : (
          diffItems.length > 0 && (
            <>
              <div role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "all"}
                  onClick={() => setActiveTab("all")}
                >
                  All Components ({diffItems.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "selected"}
                  onClick={() => setActiveTab("selected")}
                >
                  Components Selected ({selected.size})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === "options"}
                  onClick={() => setActiveTab("options")}
                >
                  Deploy Options
                </button>
              </div>

              {activeTab !== "options" && (
                <div className="table-scroll">
                  {activeTab === "all" ? (
                    <DiffTable items={diffItems} selected={selected} onToggle={toggle} />
                  ) : (
                    <DiffTable
                      items={diffItems.filter((item) => selected.has(diffItemKey(item)))}
                      selected={selected}
                      onToggle={toggle}
                      mode="remove"
                    />
                  )}
                </div>
              )}

              {activeTab === "options" && (
                <div className="deploy-options-panel">
                  <label>
                    Test level
                    <select value={testLevel} onChange={(e) => setTestLevel(e.target.value as TestLevel)}>
                      <option value="NoTestRun">No Test Run</option>
                      <option value="RunSpecifiedTests">Run Specified Tests</option>
                      <option value="RunLocalTests">Run Local Tests</option>
                      <option value="RunAllTestsInOrg">Run All Tests In Org</option>
                    </select>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={ignoreWarnings}
                      onChange={(e) => setIgnoreWarnings(e.target.checked)}
                    />
                    Ignore warnings
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowMissingFiles}
                      onChange={(e) => setAllowMissingFiles(e.target.checked)}
                    />
                    Allow missing components
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={autoUpdatePackage}
                      onChange={(e) => setAutoUpdatePackage(e.target.checked)}
                    />
                    Auto update package
                  </label>
                  {testLevel === "RunSpecifiedTests" && (
                    <label>
                      Select Tests
                      <textarea
                        value={runTestsInput}
                        onChange={(e) => setRunTestsInput(e.target.value)}
                        placeholder="names of test classes in a comma-separated list"
                      />
                    </label>
                  )}
                  <label>
                    <input type="checkbox" checked={validateOnly} onChange={(e) => setValidateOnly(e.target.checked)} />
                    Validate only (dry run)
                  </label>

                  <button onClick={() => handleDeploy()} disabled={selected.size === 0 || missingRequiredTests || deployDisabled}>
                    {validateOnly ? "Validate" : "Deploy"}
                  </button>
                </div>
              )}
            </>
          )
        )}
      </div>
    </div>
  );
}
