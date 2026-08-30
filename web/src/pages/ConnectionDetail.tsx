import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  fetchConnection,
  renameConnection,
  updateConnectionCoverageGate,
  testConnection,
  startOrgAuthorization,
  deleteConnection,
} from "../api/client.js";
import { SalesforceIcon, GitHubIcon } from "../ConnectionIcons.js";

export function ConnectionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [nickname, setNickname] = useState("");
  // Kept as the raw input text (not a number) so an in-progress edit — including a momentarily
  // empty field — never fights the user; parsed to a number-or-null only at save time.
  const [minCoverageInput, setMinCoverageInput] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  const [reauthorizing, setReauthorizing] = useState(false);
  const [reauthorizeError, setReauthorizeError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchConnection(id)
      .then((c) => {
        setConnection(c);
        setNickname(c.nickname);
        setMinCoverageInput(c.minCodeCoveragePercent != null ? String(c.minCodeCoveragePercent) : "");
      })
      .catch((err) => setLoadError((err as Error).message));
  }, [id]);

  const isOrg = connection?.type === "org";
  const trimmedMinCoverage = minCoverageInput.trim();
  const parsedMinCoverage = trimmedMinCoverage === "" ? null : Number(trimmedMinCoverage);
  const minCoverageInvalid = trimmedMinCoverage !== "" && (!Number.isFinite(parsedMinCoverage) || parsedMinCoverage! < 0 || parsedMinCoverage! > 100);
  const originalMinCoverage = connection?.minCodeCoveragePercent ?? null;
  const minCoverageChanged = isOrg && parsedMinCoverage !== originalMinCoverage;

  async function handleSave() {
    if (!id || !connection) return;
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      if (isOrg) {
        await updateConnectionCoverageGate(id, { nickname, minCodeCoveragePercent: parsedMinCoverage });
        setConnection((prev) => (prev ? { ...prev, nickname, minCodeCoveragePercent: parsedMinCoverage } : prev));
      } else {
        await renameConnection(id, nickname);
        setConnection((prev) => (prev ? { ...prev, nickname } : prev));
      }
      setSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!id) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection(id);
      setTestResult(result.ok ? { ok: true } : { ok: false, error: result.error });
    } catch (err) {
      setTestResult({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  }

  async function handleReauthorize() {
    if (!id) return;
    setReauthorizeError(null);
    setReauthorizing(true);
    try {
      const { authorizeUrl } = await startOrgAuthorization({ connectionId: id });
      location.href = authorizeUrl;
    } catch (err) {
      setReauthorizeError((err as Error).message);
      setReauthorizing(false);
    }
  }

  async function handleDelete() {
    if (!id || !connection) return;
    if (!confirm(`Delete ${connection.nickname}? This cannot be undone.`)) return;
    try {
      await deleteConnection(id);
      navigate("/connections");
    } catch (err) {
      setSaveError((err as Error).message);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!connection) return <p>Loading…</p>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/connections">Connections</Link>
        <span aria-hidden="true"> › </span>
        <span>{connection.nickname}</span>
      </nav>

      <h1>
        {isOrg ? <SalesforceIcon /> : <GitHubIcon />} {connection.nickname}
      </h1>

      {connection.lastError && (
        <p role="alert">Connection expired — needs re-authorization ({connection.lastError})</p>
      )}

      <form className="connection-fields" onSubmit={(e) => e.preventDefault()}>
        <label>
          Type
          <select value={isOrg ? "org" : "git"} disabled>
            <option value="org">Salesforce Org</option>
            <option value="git">GitHub Repo</option>
          </select>
        </label>

        <label>
          Name
          <input
            value={nickname}
            onChange={(e) => {
              setNickname(e.target.value);
              setSaved(false);
            }}
          />
        </label>

        {isOrg ? (
          <>
            <label>
              Environment
              <select value={connection.orgType ?? "sandbox"} disabled>
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </label>
            <label>
              Salesforce Login
              <input value={connection.username ?? "—"} disabled />
            </label>
            <label>
              Instance Url
              <input value={connection.instanceUrl ?? ""} disabled />
            </label>
            <label>
              Minimum code coverage %
              <input
                type="number"
                min={0}
                max={100}
                placeholder="No minimum"
                value={minCoverageInput}
                onChange={(e) => {
                  setMinCoverageInput(e.target.value);
                  setSaved(false);
                }}
              />
            </label>
          </>
        ) : (
          <>
            <label>
              Remote Url
              <input value={connection.remoteUrl ?? ""} disabled />
            </label>
            <label>
              Branch
              <input value={connection.defaultBranch ?? ""} disabled />
            </label>
          </>
        )}
      </form>

      {saveError && <p role="alert">{saveError}</p>}
      {saved && <p role="status">Saved.</p>}
      {testResult &&
        (testResult.ok ? (
          <p role="status">Connection is working.</p>
        ) : (
          <p role="alert">Connection test failed: {testResult.error}</p>
        ))}
      {reauthorizeError && <p role="alert">{reauthorizeError}</p>}

      <div className="form-actions">
        {isOrg && (
          <button type="button" onClick={handleReauthorize} disabled={reauthorizing}>
            {reauthorizing ? "Redirecting to Salesforce…" : "Re-authorize"}
          </button>
        )}
        <button
          type="button"
          onClick={handleSave}
          disabled={
            saving ||
            nickname.trim() === "" ||
            minCoverageInvalid ||
            (nickname === connection.nickname && !minCoverageChanged)
          }
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={handleTest} disabled={testing}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button type="button" onClick={handleDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
