import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  type ConnectionSummary,
  type DiffItem,
  type TestLevel,
  type DeployComponentSelection,
  fetchConnections,
  fetchDiff,
  createDeployment,
} from "../api/client.js";
import { DiffTree, diffItemKey } from "../components/DiffTree.js";

function actionForStatus(status: DiffItem["status"]): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

export function NewDeployment() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testLevel, setTestLevel] = useState<TestLevel>("NoTestRun");
  const [validateOnly, setValidateOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);

  async function handleLoadDiff() {
    setError(null);
    try {
      const items = await fetchDiff(sourceId, targetId);
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
      <h1>New Deployment</h1>
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
      <button onClick={handleLoadDiff} disabled={!sourceId || !targetId}>
        Load Diff
      </button>

      {diffItems.length > 0 && (
        <>
          <DiffTree items={diffItems} selected={selected} onToggle={toggle} />

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
