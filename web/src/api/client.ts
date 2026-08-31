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
  // The Salesforce username this org connection is authorized as, captured at (re-)authorization
  // time. Org connections only.
  username?: string | null;
  // The minimum aggregate Apex coverage a deploy to this connection must meet before it's allowed
  // to stand — see the coverage gate in DeploymentEditor.tsx. Org connections only; null/undefined
  // means no gate is configured.
  minCodeCoveragePercent?: number | null;
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

export function fetchConnection(id: string): Promise<ConnectionSummary> {
  return fetch(`/api/connections/${id}`).then((r) => json(r));
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

export function renameConnection(id: string, nickname: string): Promise<{ id: string }> {
  return fetch(`/api/connections/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nickname }),
  }).then((r) => json(r));
}

// nickname is re-sent alongside minCodeCoveragePercent because the PATCH route always requires
// it (a plain rename shares the same endpoint) — see ConnectionDetail.tsx, which always has the
// current nickname in hand from its own form.
export function updateConnectionCoverageGate(
  id: string,
  input: { nickname: string; minCodeCoveragePercent: number | null }
): Promise<{ id: string }> {
  return fetch(`/api/connections/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function testConnection(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return fetch(`/api/connections/${id}/test`, { method: "POST" }).then((r) => json(r));
}

export interface DiffItem {
  type: string;
  fullName: string;
  status: "added" | "modified" | "removed" | "unchanged";
  lastModifiedDate?: string;
  lastModifiedByName?: string;
}

export function fetchDiff(
  sourceConnectionId: string,
  targetConnectionId: string,
  types?: string[],
  branches?: { sourceBranch?: string; targetBranch?: string }
): Promise<DiffItem[]> {
  const typesParam = types && types.length > 0 ? `&types=${encodeURIComponent(types.join(","))}` : "";
  const sourceBranchParam = branches?.sourceBranch ? `&sourceBranch=${encodeURIComponent(branches.sourceBranch)}` : "";
  const targetBranchParam = branches?.targetBranch ? `&targetBranch=${encodeURIComponent(branches.targetBranch)}` : "";
  return fetch(
    `/api/diff?sourceConnectionId=${sourceConnectionId}&targetConnectionId=${targetConnectionId}${typesParam}${sourceBranchParam}${targetBranchParam}`
  ).then((r) => json(r));
}

export function fetchMetadataTypes(connectionId: string, branch?: string): Promise<string[]> {
  const branchParam = branch ? `&branch=${encodeURIComponent(branch)}` : "";
  return fetch(`/api/metadata-types?connectionId=${connectionId}${branchParam}`).then((r) => json(r));
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
  // Every component attached to this run (the History page lists these per row) — attached in
  // bulk server-side, not fetched per deployment.
  items: DeploymentItem[];
  // Set when this deployment was created by a pipeline run's hop rather than directly by a user —
  // the Deployments page excludes these (they're driven from the pipeline run's own page), while
  // History still shows everything.
  pipeline_run_id: string | null;
  // The aggregate Apex coverage this run's tests reported, and the raw per-class breakdown as a
  // JSON string (parse before use) — both null when no tests ran (e.g. NoTestRun) or the target
  // is a git connection. See the coverage gate in DeploymentEditor.tsx.
  coverage_percent: number | null;
  coverage_details: string | null;
  // Branch overrides fixed at draft creation — see createDraftDeployment. Null means that side's
  // connection used its own default branch (or isn't a git connection at all).
  source_branch: string | null;
  target_branch: string | null;
  // Basic Apex anti-pattern findings (see engine/staticAnalysis.ts) for the content this run
  // actually deployed, as a JSON string (parse before use) — null when nothing was flagged.
  // Advisory only: never affects the deployment's own outcome.
  static_analysis_findings: string | null;
  // When set (only meaningful while status is 'pending'), the ISO time this draft is scheduled to
  // run automatically — see scheduler.ts. Null means it isn't scheduled.
  scheduled_at: string | null;
}

export interface StaticAnalysisFinding {
  file: string;
  line: number;
  rule: "soql-dml-in-loop" | "hardcoded-id" | "missing-sharing" | "empty-catch";
  message: string;
}

export interface DeploymentItem {
  metadata_type: string;
  api_name: string;
  action: string;
  status: string;
  error_message: string | null;
}

export interface DeploymentDetail extends DeploymentSummary {
  components: DeployComponentSelection[];
  run_tests: string[];
  // Type of the target connection, resolved server-side. Rollback only applies to org targets.
  target_connection_type: "org" | "git" | null;
}

export function createDraftDeployment(input: {
  title?: string;
  sourceConnectionId: string;
  targetConnectionId: string;
  // Overrides that connection's own default branch for this deployment only — git connections
  // only, fixed for the deployment's lifetime. Omit to use whatever branch the connection is
  // currently configured with.
  sourceBranch?: string;
  targetBranch?: string;
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

export function scheduleDeployment(id: string, input: { scheduledAt: string; runBy?: string }): Promise<DeploymentDetail> {
  return fetch(`/api/deployments/${id}/schedule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function cancelSchedule(id: string): Promise<DeploymentDetail> {
  return fetch(`/api/deployments/${id}/schedule/cancel`, { method: "POST" }).then((r) => json(r));
}

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
  // Governs partial-hop-failure handling for every run of this pipeline — see pipelineRuns.ts on
  // the server for the exact semantics.
  trackComponentsIndependently: boolean;
}

export function fetchPipelines(): Promise<Pipeline[]> {
  return fetch("/api/pipelines").then((r) => json(r));
}

export function fetchPipeline(id: string): Promise<Pipeline> {
  return fetch(`/api/pipelines/${id}`).then((r) => json(r));
}

export function createPipeline(input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
  return fetch("/api/pipelines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function updatePipeline(id: string, input: { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean }): Promise<Pipeline> {
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

export interface PipelineRunComponent {
  type: string;
  fullName: string;
}

export interface PipelineRunSummary {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentCount: number;
  componentsAtFinalStage: number;
}

export interface PipelineStepDeploymentItem {
  metadataType: string;
  apiName: string;
  status: "pending" | "succeeded" | "failed";
}

export interface PipelineStepDeployment {
  id: string;
  stepIndex: number;
  status: string;
  validateOnly: boolean;
  startedAt: string;
  finishedAt: string | null;
  errorDetail: string | null;
  items: PipelineStepDeploymentItem[];
}

export interface ComponentPosition {
  type: string;
  fullName: string;
  stage: number;
  reachedAt: string | null;
}

export interface PipelineRunDetail {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentList: PipelineRunComponent[];
  connectionIds: string[];
  trackComponentsIndependently: boolean;
  deployments: PipelineStepDeployment[];
  positions: ComponentPosition[];
}

export function createPipelineRun(pipelineId: string, input: { title?: string; components: PipelineRunComponent[] }): Promise<{ id: string }> {
  return fetch(`/api/pipelines/${pipelineId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}

export function fetchPipelineRuns(pipelineId: string): Promise<PipelineRunSummary[]> {
  return fetch(`/api/pipelines/${pipelineId}/runs`).then((r) => json(r));
}

export function fetchPipelineRun(runId: string): Promise<PipelineRunDetail> {
  return fetch(`/api/pipeline-runs/${runId}`).then((r) => json(r));
}

export function deployPipelineStep(
  runId: string,
  stepIndex: number,
  input: { validateOnly: boolean; runBy?: string }
): Promise<{ deploymentId: string; skipped: boolean }> {
  return fetch(`/api/pipeline-runs/${runId}/steps/${stepIndex}/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then((r) => json(r));
}
