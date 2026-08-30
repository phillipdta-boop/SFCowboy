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
import { getDisplayName } from "../displayName.js";

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
  // The branch override fixed at this deployment's creation, if any — meaningful only when that
  // side's connection is a git connection. Threaded into every diff/metadata-types call so what's
  // reviewed always matches what a deploy would actually read from/push to.
  sourceBranch?: string | null;
  targetBranch?: string | null;
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
  sourceBranch,
  targetBranch,
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

  const [typesLoading, setTypesLoading] = useState(false);
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // "selected" is the default landing tab: most visits are re-opening a deployment that already
  // has components picked, so showing what's already selected first (rather than the full add
  // picker) matches what the user actually came here to look at.
  const [activeTab, setActiveTab] = useState<"selected" | "add" | "options">("selected");
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
  // A target with a coverage minimum configured (see ConnectionDetail.tsx) can't be gated at all
  // when no tests run — Salesforce reports no coverage data for NoTestRun, so there'd be nothing
  // to check the threshold against. Blocking here client-side is just guidance; the server enforces
  // the actual gate once tests do run (see the coverage gate in engine/deploy.ts).
  const targetMinCoverage = connections.find((c) => c.id === targetId)?.minCodeCoveragePercent ?? null;
  const coverageGateNeedsTests = targetMinCoverage != null && testLevel === "NoTestRun";

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

    // Re-opening a draft that already has components: restore the type filter they implied, and
    // show the existing selection immediately from the draft's own saved data (see cachedItems
    // below) rather than waiting on a live diff — the Add Components tab is what actually loads
    // a fresh diff, and only once the user visits it (see the lazy-load effect below), so opening
    // a deployment never blocks on a Salesforce round-trip just to show what's already picked.
    const initialTypes = new Set((initialComponents ?? []).map((c) => c.type));
    setSelectedTypes(initialTypes);
    setSelected(new Set((initialComponents ?? []).map(componentKey)));

    setTypesLoading(true);
    // Omits the branch argument entirely rather than passing it as undefined, so an ordinary
    // call (no override) looks exactly like it always has.
    (sourceBranch ? fetchMetadataTypes(sourceId, sourceBranch) : fetchMetadataTypes(sourceId))
      .then((types) => {
        setAvailableTypes(types);
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setTypesLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  // The draft's already-saved components, shaped like diff rows (with a status derived from
  // their action) so the Selected tab can render them without ever needing a live diff. Cheap to
  // recompute each render — no separate state needed.
  const cachedItems: DiffItem[] = (initialComponents ?? []).map((c) => ({
    type: c.type,
    fullName: c.fullName,
    status: c.action === "add" ? "added" : c.action === "delete" ? "removed" : "modified",
  }));

  // The Selected tab's rows: prefer a freshly loaded diff entry (has real status/dates) over the
  // cached stand-in for the same component, so switching to Add Components and loading a diff
  // transparently upgrades what's already showing instead of replacing it.
  const itemsByKey = new Map<string, DiffItem>();
  for (const item of cachedItems) itemsByKey.set(diffItemKey(item), item);
  for (const item of diffItems) itemsByKey.set(diffItemKey(item), item);
  const selectedItems = [...selected].map((key) => itemsByKey.get(key)).filter((item): item is DiffItem => !!item);

  // Loading the diff is deferred until the user actually visits Add Components — picking types
  // and browsing/searching the full org diff has nothing to do with seeing what's already
  // selected, so it shouldn't hold up opening the deployment. Once the types this draft already
  // implies are known, visiting the tab for the first time (or reopening it after the type
  // selection changed) loads it automatically, so there's no extra "now click Load Diff" step for
  // the common case of just wanting to see the fuller picker.
  useEffect(() => {
    if (activeTab !== "add") return;
    if (diffItems.length > 0 || diffLoading) return;
    if (selectedTypes.size === 0) return;
    loadDiff(selectedTypes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

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
      // The branches argument is omitted entirely (rather than passed as undefined) when neither
      // side has an override, so an ordinary org-to-org/no-branch call looks exactly like it
      // always has.
      const expandedTypes = expandTypeSelection(types);
      const items =
        sourceBranch || targetBranch
          ? await fetchDiff(sourceId, targetId, expandedTypes, { sourceBranch: sourceBranch ?? undefined, targetBranch: targetBranch ?? undefined })
          : await fetchDiff(sourceId, targetId, expandedTypes);
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
  // request per click. Built from selectedItems (cache-or-diff, whichever is freshest) rather
  // than raw diffItems, so this fires correctly even before the user has ever visited Add
  // Components — otherwise a re-opened draft's untouched cached selection would autosave as
  // empty the moment anything else (e.g. a Deploy Options field) changed.
  useEffect(() => {
    if (!autosaveEnabled) return;
    // Guards against saving an empty selection before there's anything to select FROM yet (e.g.
    // a brand-new draft before its first diff loads) — once either a cached or live source
    // exists, a genuinely empty `selected` (the user deliberately unchecked everything) is a
    // real state worth saving, not a sign nothing has loaded.
    if (cachedItems.length === 0 && diffItems.length === 0) return;
    const components: DeployComponentSelection[] = selectedItems.map((item) => ({
      type: item.type,
      fullName: item.fullName,
      action: actionForStatus(item.status),
    }));

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
  }, [autosaveEnabled, deploymentId, selected, diffItems, testLevel, validateOnly, ignoreWarnings, allowMissingFiles, autoUpdatePackage, runTestsInput]);

  // The toolbar's Validate/Deploy buttons always run as their name says, regardless of the
  // "Validate only" checkbox below the table; the checkbox only drives the plain Deploy button
  // down there. Passing no override runs with whatever the checkbox is currently set to.
  async function handleDeploy(overrideValidateOnly?: boolean) {
    setError(null);
    const components: DeployComponentSelection[] = selectedItems.map((item) => ({
      type: item.type,
      fullName: item.fullName,
      action: actionForStatus(item.status),
    }));

    try {
      const { id } = await onDeploy({
        components,
        testLevel,
        validateOnly: overrideValidateOnly ?? validateOnly,
        ignoreWarnings,
        allowMissingFiles,
        autoUpdatePackage,
        runTests,
        runBy: getDisplayName() || undefined,
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

      {/* One card for the three things you need to see/do before scrolling to the component
          list: how the last run went (if any), which environments are involved, and the
          buttons to act on it — rather than three separately-boxed pieces stacked on the page. */}
      <div className="deployment-summary">
        {statusPanel}
        <EnvironmentSummary
          connections={connections}
          sourceId={sourceId}
          targetId={targetId}
          sourceBranch={sourceBranch}
          targetBranch={targetBranch}
        />
        <div className="deployment-toolbar">
          <button
            type="button"
            onClick={() => handleDeploy(true)}
            disabled={selected.size === 0 || missingRequiredTests || coverageGateNeedsTests || deployDisabled}
          >
            Validate
          </button>
          <button
            type="button"
            onClick={() => handleDeploy(false)}
            disabled={selected.size === 0 || missingRequiredTests || coverageGateNeedsTests || deployDisabled}
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
      </div>

      {error && <p role="alert">{error}</p>}

      {/* While metadata types are still loading, show a spinner in place of the tabs/table area
          rather than leaving a blank gap — this is the only thing opening a deployment still
          has to wait on, now that the Selected tab renders from the draft's own saved data
          instead of a live diff. */}
      {typesLoading && <div className="spinner" role="status" aria-label="Loading…" />}

      {/* Tabs appear as soon as metadata types are known, before any diff has been loaded —
          picking types and loading the diff now happens inside the Add Components tab itself,
          rather than in a picker that sat above the tabs regardless of which one was open. */}
      {!typesLoading && availableTypes.length > 0 && (
        <div className="diff-results">
          <div role="tablist">
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
              aria-selected={activeTab === "add"}
              onClick={() => setActiveTab("add")}
            >
              Add Components ({diffItems.length})
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

          {/* selectedItems is available instantly from the draft's own saved data (see
              cachedItems above), so this tab never waits on diffLoading — that flag only ever
              reflects the Add Components tab's own (lazy, on-demand) diff fetch. */}
          {activeTab === "selected" && (
            <div className="table-scroll">
              <DiffTable items={selectedItems} selected={selected} onToggle={toggle} mode="remove" />
            </div>
          )}

          {activeTab === "add" && (
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
              {diffLoading && <div className="spinner" role="status" aria-label="Loading diff…" />}
              {!diffLoading && diffItems.length > 0 && (
                <div className="table-scroll">
                  <DiffTable items={diffItems} selected={selected} onToggle={toggle} />
                </div>
              )}
            </>
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
              {coverageGateNeedsTests && (
                <p role="alert">
                  This target requires {targetMinCoverage}%+ code coverage — pick a test level that runs tests.
                </p>
              )}
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

              <button onClick={() => handleDeploy()} disabled={selected.size === 0 || missingRequiredTests || coverageGateNeedsTests || deployDisabled}>
                {validateOnly ? "Validate" : "Deploy"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
