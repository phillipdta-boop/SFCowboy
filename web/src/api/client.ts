export interface ConnectionSummary {
  id: string;
  type: "org" | "git";
  nickname: string;
  createdAt: string;
  lastUsedAt: string | null;
  instanceUrl?: string;
  orgType?: "sandbox" | "production";
  remoteUrl?: string;
  defaultBranch?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
  return res.json();
}

// For endpoints that return 204 No Content on success (DELETE routes) — `json<T>` can't be used
// for these since it always calls res.json() on the success path, which throws on an empty body.
async function checkOk(res: Response): Promise<void> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({ error: res.statusText }))).error ?? res.statusText);
}

export function fetchConnections(): Promise<ConnectionSummary[]> {
  return fetch("/api/connections").then((r) => json(r));
}

export function bootstrapOrgConnection(input: {
  nickname: string;
  orgType: "sandbox" | "production";
  username: string;
  password: string;
  securityToken?: string;
}): Promise<ConnectionSummary> {
  return fetch("/api/connections/org/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function createGitConnection(input: {
  nickname: string;
  remoteUrl: string;
  defaultBranch: string;
  authToken: string;
}): Promise<ConnectionSummary> {
  return fetch("/api/connections/git", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function deleteConnection(id: string): Promise<void> {
  return fetch(`/api/connections/${id}`, { method: "DELETE" }).then(checkOk);
}

export interface DiffItem {
  type: string;
  fullName: string;
  status: "added" | "modified" | "removed" | "unchanged";
}

export function fetchDiff(sourceConnectionId: string, targetConnectionId: string): Promise<DiffItem[]> {
  return fetch(`/api/diff?sourceConnectionId=${sourceConnectionId}&targetConnectionId=${targetConnectionId}`).then((r) => json(r));
}

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

export interface DeploymentSummary {
  id: string;
  source_connection_id: string;
  target_connection_id: string;
  status: string;
  test_level: TestLevel;
  validate_only: number;
  started_at: string;
  finished_at: string | null;
  error_detail: string | null;
  is_rollback_of: string | null;
}

export interface DeploymentDetail extends DeploymentSummary {
  components: DeployComponentSelection[];
  items: { metadata_type: string; api_name: string; action: string; status: string; error_message: string | null }[];
  // Type of the target connection, resolved server-side. Rollback only applies to org targets.
  target_connection_type: "org" | "git" | null;
}

export function createDeployment(input: {
  sourceConnectionId: string;
  targetConnectionId: string;
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly?: boolean;
}): Promise<{ id: string }> {
  return fetch("/api/deployments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function fetchDeployment(id: string): Promise<DeploymentDetail> {
  return fetch(`/api/deployments/${id}`).then((r) => json(r));
}

// GET /api/deployments returns raw deployment rows only — no components/items join, unlike
// GET /api/deployments/:id. Hence the narrower DeploymentSummary type; only fetchDeployment(id)
// returns components and items.
export function fetchDeployments(): Promise<DeploymentSummary[]> {
  return fetch("/api/deployments").then((r) => json(r));
}

export function rollbackDeployment(id: string): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/rollback`, { method: "POST" }).then((r) => json(r));
}

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
}

export function fetchPipelines(): Promise<Pipeline[]> {
  return fetch("/api/pipelines").then((r) => json(r));
}

export function createPipeline(input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  return fetch("/api/pipelines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function updatePipeline(id: string, input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  return fetch(`/api/pipelines/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function deletePipeline(id: string): Promise<void> {
  return fetch(`/api/pipelines/${id}`, { method: "DELETE" }).then(checkOk);
}
