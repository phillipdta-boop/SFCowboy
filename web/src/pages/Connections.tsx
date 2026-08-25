import { useEffect, useState } from "react";
import {
  type ConnectionSummary,
  fetchConnections,
  startOrgConnectionUrl,
  createGitConnection,
  deleteConnection,
} from "../api/client.js";

export function Connections() {
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [orgNickname, setOrgNickname] = useState("");
  const [orgType, setOrgType] = useState<"sandbox" | "production">("sandbox");
  const [gitNickname, setGitNickname] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [authToken, setAuthToken] = useState("");

  function refresh() {
    fetchConnections().then(setConnections);
  }

  useEffect(refresh, []);

  async function handleAddGit(e: React.FormEvent) {
    e.preventDefault();
    await createGitConnection({ nickname: gitNickname, remoteUrl, defaultBranch, authToken });
    setGitNickname("");
    setRemoteUrl("");
    setAuthToken("");
    refresh();
  }

  async function handleDelete(id: string) {
    await deleteConnection(id);
    refresh();
  }

  return (
    <div>
      <h1>Connections</h1>
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
