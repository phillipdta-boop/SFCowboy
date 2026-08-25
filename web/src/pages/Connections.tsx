import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  type ConnectionSummary,
  fetchConnections,
  startOrgConnectionUrl,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";

export function Connections() {
  const [searchParams] = useSearchParams();
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [orgNickname, setOrgNickname] = useState("");
  const [orgType, setOrgType] = useState<"sandbox" | "production">("sandbox");
  const [gitNickname, setGitNickname] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [authToken, setAuthToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    fetchConnections()
      .then(setConnections)
      .catch((err) => setError((err as Error).message));
  }

  useEffect(refresh, []);

  // The OAuth callback redirects back here with ?connected=1 or ?error=... — without reading
  // these, a failed org connection (expired code, bad secret, wrong callback URL) would silently
  // drop the user on an unchanged page with no feedback at all.
  const oauthConnected = searchParams.get("connected") === "1";
  const oauthFailed = searchParams.get("error") !== null;

  async function handleAddGit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await createGitConnection({ nickname: gitNickname, remoteUrl, defaultBranch, authToken });
      setGitNickname("");
      setRemoteUrl("");
      setAuthToken("");
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(id: string) {
    setError(null);
    try {
      await deleteConnection(id);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div>
      <h1>Connections</h1>
      {oauthConnected && <p role="status">Org connected successfully.</p>}
      {/* Deliberately generic: the server-side detail can include the Salesforce HTTP status and
          response body, so it is logged server-side rather than shown in the browser. */}
      {oauthFailed && <p role="alert">Failed to connect the org: see server logs for details.</p>}
      {error && <p role="alert">{error}</p>}
      <ul>
        {connections.map((c) => (
          <li key={c.id}>
            <strong>{c.nickname}</strong> ({c.type === "org" ? c.orgType : "git"})
            <button onClick={() => handleDelete(c.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <h2>Connect an Org</h2>
      <label>
        Nickname
        <input value={orgNickname} onChange={(e) => setOrgNickname(e.target.value)} />
      </label>
      <label>
        Org type
        <select value={orgType} onChange={(e) => setOrgType(e.target.value as "sandbox" | "production")}>
          <option value="sandbox">Sandbox</option>
          <option value="production">Production</option>
        </select>
      </label>
      <a href={startOrgConnectionUrl(orgNickname, orgType)}>
        <button disabled={!orgNickname}>Connect</button>
      </a>

      <h2>Add a Git Repo</h2>
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
        <button type="submit">Add git repo</button>
      </form>
    </div>
  );
}
