import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type ConnectionSummary,
  fetchConnections,
  startOrgAuthorization,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";

function SalesforceIcon() {
  return (
    <svg
      className="connection-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M10.7 6.9c.8-.8 1.9-1.3 3.1-1.3 1.7 0 3.1 1 3.8 2.4.6-.3 1.3-.4 2-.4 2.5 0 4.4 2 4.4 4.4s-2 4.4-4.4 4.4H6.9C4.7 16.4 3 14.7 3 12.5c0-1.9 1.3-3.4 3.1-3.8.4-1.5 1.7-2.6 3.3-2.6.5 0 .9.1 1.3.3z"
        fill="#00A1E0"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="connection-icon" width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

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
        {orgConnections.map((c) => (
          <li key={c.id}>
            <SalesforceIcon /> <strong>{c.nickname}</strong> ({c.orgType})
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
        ))}
      </ul>

      <h2>Connected Git Repos</h2>
      <ul>
        {gitConnections.map((c) => (
          <li key={c.id}>
            <GitHubIcon /> <strong>{c.nickname}</strong>
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
