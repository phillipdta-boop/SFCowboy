import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  type ConnectionSummary,
  fetchConnections,
  startOrgAuthorization,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";
import { SalesforceIcon, GitHubIcon } from "../ConnectionIcons.js";
import { environmentBadge } from "../deploymentDisplay.js";

type AddMode = "closed" | "choose" | "org" | "git";

export function Connections() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [addMode, setAddMode] = useState<AddMode>("closed");

  const [orgNickname, setOrgNickname] = useState("");
  const [orgType, setOrgType] = useState<"sandbox" | "production">("sandbox");
  const [connecting, setConnecting] = useState(false);
  const [reauthorizingId, setReauthorizingId] = useState<string | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [orgStatus, setOrgStatus] = useState<string | null>(null);

  const [gitNickname, setGitNickname] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [authToken, setAuthToken] = useState("");
  const [gitError, setGitError] = useState<string | null>(null);

  const [listError, setListError] = useState<string | null>(null);

  function refresh() {
    fetchConnections()
      .then(setConnections)
      .catch((err) => setListError((err as Error).message));
  }

  useEffect(refresh, []);

  useEffect(() => {
    if (searchParams.get("connected")) {
      setOrgStatus("Org connected successfully.");
      refresh();
      setSearchParams({}, { replace: true });
    } else if (searchParams.get("reconnected")) {
      setOrgStatus("Org reconnected successfully.");
      refresh();
      setSearchParams({}, { replace: true });
    } else if (searchParams.get("error")) {
      setOrgError(searchParams.get("error"));
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function closeAdd() {
    setAddMode("closed");
    setOrgError(null);
    setGitError(null);
  }

  async function handleConnectOrg(e: React.FormEvent) {
    e.preventDefault();
    setOrgError(null);
    setOrgStatus(null);
    setConnecting(true);
    try {
      const { authorizeUrl } = await startOrgAuthorization({ nickname: orgNickname, orgType });
      location.href = authorizeUrl;
    } catch (err) {
      setOrgError((err as Error).message);
      setConnecting(false);
    }
  }

  async function handleReauthorize(id: string) {
    setOrgError(null);
    setOrgStatus(null);
    setReauthorizingId(id);
    try {
      const { authorizeUrl } = await startOrgAuthorization({ connectionId: id });
      location.href = authorizeUrl;
    } catch (err) {
      setOrgError((err as Error).message);
      setReauthorizingId(null);
    }
  }

  async function handleAddGit(e: React.FormEvent) {
    e.preventDefault();
    setGitError(null);
    try {
      await createGitConnection({ nickname: gitNickname, remoteUrl, defaultBranch, authToken });
      setGitNickname("");
      setRemoteUrl("");
      setAuthToken("");
      setAddMode("closed");
      refresh();
    } catch (err) {
      setGitError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    setListError(null);
    try {
      await deleteConnection(id);
      refresh();
    } catch (err) {
      setListError((err as Error).message);
    }
  }

  const orgConnections = connections.filter((c) => c.type === "org");
  const gitConnections = connections.filter((c) => c.type === "git");

  return (
    <div>
      <h1>
        Connections
        <button type="button" className="page-action-button" onClick={() => setAddMode("choose")}>
          New Connection
        </button>
      </h1>
      {listError && <p role="alert">{listError}</p>}
      {/* Rendered at the top level (not inside the org-form disclosure) because returning from
          Salesforce — success or failure — always lands with the form closed. */}
      {orgError && <p role="alert">{orgError}</p>}
      {orgStatus && <p role="status">{orgStatus}</p>}

      {addMode === "choose" && (
        <div className="connection-chooser">
          <p>What would you like to connect?</p>
          <button type="button" onClick={() => setAddMode("org")}>
            <SalesforceIcon /> Connect Salesforce Org
          </button>
          <button type="button" onClick={() => setAddMode("git")}>
            <GitHubIcon /> Connect GitHub Repo
          </button>
          <button type="button" onClick={closeAdd}>
            Cancel
          </button>
        </div>
      )}

      {addMode === "org" && (
        <>
          <h2>
            <SalesforceIcon /> Connect a Salesforce Org
          </h2>
          <p>Enter a nickname and org type, then log in with Salesforce. No password ever touches this app.</p>
          <form onSubmit={handleConnectOrg}>
            <label>
              Nickname
              <input value={orgNickname} onChange={(e) => setOrgNickname(e.target.value)} required />
            </label>
            <label>
              Org type
              <select value={orgType} onChange={(e) => setOrgType(e.target.value as "sandbox" | "production")}>
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </label>
            <div className="form-actions">
              <button type="submit" disabled={connecting}>
                {connecting ? "Redirecting to Salesforce…" : "Login with Salesforce"}
              </button>
              <button type="button" onClick={closeAdd} disabled={connecting}>
                Cancel
              </button>
            </div>
          </form>
        </>
      )}

      {addMode === "git" && (
        <>
          <h2>
            <GitHubIcon /> Connect a GitHub Repo
          </h2>
          {gitError && <p role="alert">{gitError}</p>}
          <form onSubmit={handleAddGit}>
            <label>
              Git nickname
              <input value={gitNickname} onChange={(e) => setGitNickname(e.target.value)} />
            </label>
            <label>
              Remote URL
              <input value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} />
            </label>
            <label>
              Branch
              <input value={defaultBranch} onChange={(e) => setDefaultBranch(e.target.value)} />
            </label>
            <label>
              Auth token
              <input type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} />
            </label>
            <div className="form-actions">
              <button type="submit">Add git repo</button>
              <button type="button" onClick={closeAdd}>
                Cancel
              </button>
            </div>
          </form>
        </>
      )}

      <h2>Connected Orgs</h2>
      <ul>
        {orgConnections.map((c) => {
          const badge = environmentBadge(connections, c.id);
          return (
          <li key={c.id}>
            <SalesforceIcon /> <Link to={`/connections/${c.id}`}><strong>{c.nickname}</strong></Link>{" "}
            <span className={`badge ${badge.className}`}>{badge.label}</span>
            {c.lastError && (
              <>
                <span className="badge badge-removed">Connection expired — needs re-authorization</span>
                <button onClick={() => handleReauthorize(c.id)} disabled={reauthorizingId === c.id}>
                  {reauthorizingId === c.id ? "Redirecting to Salesforce…" : "Reconnect"}
                </button>
              </>
            )}
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
          );
        })}
      </ul>

      <h2>Connected Git Repos</h2>
      <ul>
        {gitConnections.map((c) => (
          <li key={c.id}>
            <GitHubIcon /> <Link to={`/connections/${c.id}`}><strong>{c.nickname}</strong></Link>
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
