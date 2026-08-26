import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type ConnectionSummary,
  type DiffItem,
  type TestLevel,
  type DeployComponentSelection,
  fetchConnections,
  fetchMetadataTypes,
  fetchDiff,
  createDeployment,
} from "../api/client.js";
import { DiffTable, diffItemKey } from "../components/DiffTable.js";
import { MetadataTypeSelector } from "../components/MetadataTypeSelector.js";

function actionForStatus(status: DiffItem["status"]): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

function nicknameFor(connections: ConnectionSummary[], id: string): string {
  return connections.find((c) => c.id === id)?.nickname ?? id;
}

export function NewDeployment() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");

  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeTab, setActiveTab] = useState<"all" | "selected">("all");
  const [testLevel, setTestLevel] = useState<TestLevel>("NoTestRun");
  const [validateOnly, setValidateOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  useEffect(() => {
    setAvailableTypes([]);
    setSelectedTypes(new Set());
    setDiffItems([]);
    if (!sourceId || !targetId) return;

    setError(null);
    fetchMetadataTypes(sourceId)
      .then((types) => {
        setAvailableTypes(types);
      })
      .catch((err) => setError((err as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, targetId]);

  function toggleType(type: string) {
    setSelectedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }

  async function handleLoadDiff() {
    setError(null);
    try {
      const items = await fetchDiff(sourceId, targetId, Array.from(selectedTypes));
      setDiffItems(items);
      setSelected(new Set(items.filter((i) => i.status === "added" || i.status === "modified").map(diffItemKey)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleDeploy() {
    setError(null);
    const components: DeployComponentSelection[] = diffItems
      .filter((item) => selected.has(diffItemKey(item)))
      .map((item) => ({ type: item.type, fullName: item.fullName, action: actionForStatus(item.status) }));

    try {
      const { id } = await createDeployment({
        sourceConnectionId: sourceId,
        targetConnectionId: targetId,
        components,
        testLevel,
        validateOnly,
      });
      navigate(`/deployments/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>
        New Deployment
        {sourceId && targetId && (
          <>
            {": "}
            {nicknameFor(connections, sourceId)} → {nicknameFor(connections, targetId)}
          </>
        )}
      </h1>
      {error && <p role="alert">{error}</p>}

      <label>
        Source
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">Select source</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nickname}
            </option>
          ))}
        </select>
      </label>
      <label>
        Target
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">Select target</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.nickname}
            </option>
          ))}
        </select>
      </label>

      {availableTypes.length > 0 && (
        <>
          <h2>Component Types</h2>
          <MetadataTypeSelector
            types={availableTypes}
            selected={selectedTypes}
            onToggle={toggleType}
            onSelectAll={() => setSelectedTypes(new Set(availableTypes))}
            onSelectNone={() => setSelectedTypes(new Set())}
          />
          <button onClick={handleLoadDiff} disabled={selectedTypes.size === 0}>
            Load Diff
          </button>
        </>
      )}

      {diffItems.length > 0 && (
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
          </div>

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
            <input type="checkbox" checked={validateOnly} onChange={(e) => setValidateOnly(e.target.checked)} />
            Validate only (dry run)
          </label>

          <button onClick={handleDeploy} disabled={selected.size === 0}>
            {validateOnly ? "Validate" : "Deploy"}
          </button>
        </>
      )}
    </div>
  );
}
