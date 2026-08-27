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
  // Set when the most recent token refresh for this org failed — the Connections page offers a
  // Reconnect action for any org connection with this set.
  lastError?: string | null;
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

// Pass either {nickname, orgType} to connect a brand-new org, or {connectionId} to re-authorize
// an existing one (refreshes its stored credentials in place, without creating a duplicate).
export function startOrgAuthorization(
  input: { nickname: string; orgType: "sandbox" | "production" } | { connectionId: string }
): Promise<{ authorizeUrl: string }> {
  return fetch("/api/connections/org/authorize", {
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
  lastModifiedDate?: string;
  lastModifiedByName?: string;
}

export function fetchDiff(sourceConnectionId: string, targetConnectionId: string, types?: string[]): Promise<DiffItem[]> {
  const typesParam = types && types.length > 0 ? `&types=${encodeURIComponent(types.join(","))}` : "";
  return fetch(`/api/diff?sourceConnectionId=${sourceConnectionId}&targetConnectionId=${targetConnectionId}${typesParam}`).then((r) =>
    json(r)
  );
}

export function fetchMetadataTypes(connectionId: string): Promise<string[]> {
  return fetch(`/api/metadata-types?connectionId=${connectionId}`).then((r) => json(r));
}

export type TestLevel = "NoTestRun" | "RunSpecifiedTests" | "RunLocalTests" | "RunAllTestsInOrg";

export interface DeployComponentSelection {
  type: string;
  fullName: string;
  action: "add" | "modify" | "delete";
}

export interface DeploymentSummary {
  id: string;
  title: string | null;
  source_connection_id: string;
  target_connection_id: string;
  status: string;
  test_level: TestLevel;
  validate_only: number;
  ignore_warnings: number;
  allow_missing_files: number;
  auto_update_package: number;
  started_at: string;
  finished_at: string | null;
  error_detail: string | null;
  is_rollback_of: string | null;
  // Live progress, set once the deploy has actually reached Salesforce; null before then.
  components_deployed: number | null;
  components_total: number | null;
  tests_completed: number | null;
  tests_total: number | null;
  // Self-reported display name of whoever triggered this run — attribution, not an
  // authenticated identity (see displayName.ts). Null for a pending draft that hasn't run yet.
  run_by: string | null;
}

export interface DeploymentDetail extends DeploymentSummary {
  components: DeployComponentSelection[];
  run_tests: string[];
  items: { metadata_type: string; api_name: string; action: string; status: string; error_message: string | null }[];
  // Type of the target connection, resolved server-side. Rollback only applies to org targets.
  target_connection_type: "org" | "git" | null;
}

export function createDraftDeployment(input: {
  title?: string;
  sourceConnectionId: string;
  targetConnectionId: string;
}): Promise<{ id: string }> {
  return fetch("/api/deployments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export interface DeployRunOptions {
  components: DeployComponentSelection[];
  testLevel: TestLevel;
  validateOnly?: boolean;
  // Passed straight through to Salesforce's Metadata API deploy() call.
  ignoreWarnings?: boolean;
  allowMissingFiles?: boolean;
  autoUpdatePackage?: boolean;
  // Required by Salesforce when testLevel is RunSpecifiedTests.
  runTests?: string[];
  // Self-reported display name (see displayName.ts) — only meaningful to runDeployment/
  // rerunDeployment, which actually persist it; saveDeploymentComponents ignores it.
  runBy?: string;
}

export function runDeployment(id: string, input: DeployRunOptions): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

// Persists the current component selection to a pending draft without running it — used to
// autosave as the user picks components, so the selection survives navigating away and back.
export function saveDeploymentComponents(id: string, input: DeployRunOptions): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}`, {
    method: "PATCH",
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

export function updateDeploymentTitle(id: string, title: string | null): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  }).then((r) => json(r));
}

export function deleteDeployment(id: string): Promise<void> {
  return fetch(`/api/deployments/${id}`, { method: "DELETE" }).then(checkOk);
}

// Duplicates a deployment (any status) into a fresh pending draft with the same source, target,
// title, and components — ready to review and run again.
export function cloneDeployment(id: string): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/clone`, { method: "POST" }).then((r) => json(r));
}

// Re-runs a FINISHED deployment: clones it and immediately deploys the CURRENTLY edited
// selection (same body shape as runDeployment) as a new row, so re-running keeps producing its
// own entry in the deployment history without disturbing the original's result. Used when the
// component editor on a finished deployment's own page is used to Deploy/Validate again.
export function rerunDeployment(id: string, input: DeployRunOptions): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/rerun`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function cancelDeployment(id: string): Promise<{ id: string }> {
  return fetch(`/api/deployments/${id}/cancel`, { method: "POST" }).then((r) => json(r));
}

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
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

export function updatePipelineStatus(id: string, status: "active" | "closed"): Promise<Pipeline> {
  return fetch(`/api/pipelines/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  }).then((r) => json(r));
}
