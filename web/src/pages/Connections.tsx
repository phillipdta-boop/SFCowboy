import { useEffect, useState } from "react";
import {
  type ConnectionSummary,
  fetchConnections,
  bootstrapOrgConnection,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";

export function Connections() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);

  const [orgNickname, setOrgNickname] = useState("");
  const [orgType, setOrgType] = useState<"sandbox" | "production">("sandbox");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [securityToken, setSecurityToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [orgError, setOrgError] = useState<string | null>(null);

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

  async function handleConnectOrg(e: React.FormEvent) {
    e.preventDefault();
    setOrgError(null);
    setConnecting(true);
    try {
      await bootstrapOrgConnection({
        nickname: orgNickname,
        orgType,
        username,
        password,
        securityToken: securityToken || undefined,
      });
      setOrgNickname("");
      setUsername("");
      setPassword("");
      setSecurityToken("");
      refresh();
    } catch (err) {
      setOrgError((err as Error).message);
    } finally {
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
      <p>
        Enter your Salesforce login. This is used once to set up the connection and is never
        stored — after that, everything runs on a normal token that refreshes itself.
      </p>
      <form onSubmit={handleConnectOrg}>
        {orgError && <p role="alert">{orgError}</p>}
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
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label>
          Security token (if your org requires one)
          <input type="password" value={securityToken} onChange={(e) => setSecurityToken(e.target.value)} />
        </label>
        <button type="submit" disabled={connecting}>
          {connecting ? "Connecting… this can take up to 2 minutes" : "Connect"}
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
