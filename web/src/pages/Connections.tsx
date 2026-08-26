import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type ConnectionSummary,
  fetchConnections,
  fetchOrgPackageInfo,
  startOrgAuthorization,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";

export function Connections() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();

  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [orgNickname, setOrgNickname] = useState("");
  const [orgType, setOrgType] = useState<"sandbox" | "production">("sandbox");
  const [connecting, setConnecting] = useState(false);
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
    fetchOrgPackageInfo()
      .then((info) => setInstallUrl(info.installUrl))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (searchParams.get("connected")) {
      setOrgStatus("Org connected successfully.");
      refresh();
      setSearchParams({}, { replace: true });
    } else if (searchParams.get("error")) {
      setOrgError(searchParams.get("error"));
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

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

  async function handleAddGit(e: React.FormEvent) {
    e.preventDefault();
    setGitError(null);
    try {
      await createGitConnection({ nickname: gitNickname, remoteUrl, defaultBranch, authToken });
      setGitNickname("");
      setRemoteUrl("");
      setAuthToken("");
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
      <h1>Connections</h1>
      {listError && <p role="alert">{listError}</p>}

      <h2>Connected Orgs</h2>
      <ul>
        {orgConnections.map((c) => (
          <li key={c.id}>
            <strong>{c.nickname}</strong> ({c.orgType})
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <h2>Connected Git Repos</h2>
      <ul>
        {gitConnections.map((c) => (
          <li key={c.id}>
            <strong>{c.nickname}</strong>
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <h2>Connect an Org</h2>
      {orgError && <p role="alert">{orgError}</p>}
      {orgStatus && <p role="status">{orgStatus}</p>}
      <p>Step 1: install the SFCowboy package into the org (once per org — works for sandboxes and production alike).</p>
      {installUrl && (
        <a href={installUrl} target="_blank" rel="noreferrer">
          Install the SFCowboy package
        </a>
      )}
      <p>Step 2: log in with Salesforce to connect it. No password ever touches this app.</p>
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
        <button type="submit" disabled={connecting}>
          {connecting ? "Redirecting to Salesforce…" : "Login with Salesforce"}
        </button>
      </form>

      <h2>Add a Git Repo</h2>
      <form onSubmit={handleAddGit}>
        {gitError && <p role="alert">{gitError}</p>}
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
        <button type="submit">Add git repo</button>
      </form>
    </div>
  );
}
