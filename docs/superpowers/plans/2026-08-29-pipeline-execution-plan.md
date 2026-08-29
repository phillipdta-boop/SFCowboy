# Pipeline Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing (purely descriptive) Pipelines feature into the real deployment engine, so a user can promote a fixed set of components through a pipeline's stages one manually-validated-or-deployed hop at a time, with a UI showing each component's current stage and per-stage timestamp.

**Architecture:** A "pipeline run" is a fixed component list plus a sequence of ordinary `deployments` rows (one per hop, tagged with `pipeline_run_id`/`pipeline_step_index`), so the run reuses the entire existing deploy engine, diff engine, and `DeploymentDetailPage` untouched. A component's current stage and its per-stage timestamp are derived on read from those tagged deployments' existing `deployment_items`, not stored in a new tracking table.

**Tech Stack:** Node/Express/better-sqlite3 (server), React/Vite/TypeScript (web), Vitest + Testing Library for both.

**Spec:** `docs/superpowers/specs/2026-08-29-pipeline-execution-design.md`

## Global Constraints

- Every new server function/route follows this codebase's established conventions exactly (see spec + notes below) — no new patterns invented where an existing one already fits.
- `track_components_independently` defaults to `1` (independent tracking) for every pipeline, matching the spec's approved default.
- A component is eligible for step `N` iff its derived stage equals `N`; only a *succeeded, non-validate-only* deployment at step `N` can advance it past that hop.
- Never trigger a real Salesforce deploy from an automated test — mock `deploy.runDeployment` / `sfConnection.buildOrgConnection` / `orgComponents.listOrgComponents` the same way `engine/routes.test.ts` already does. Real verification against live orgs happens only via deliberate manual browser clicks in the final task.
- Back up `server/sfcowboy.db` before the migration task's manual dry-run/deploy step, per this project's standing rule (a `.bak-<timestamp>` copy is enough — it must NOT be committed to git, `*.db*` outside plain `.db` is not gitignored by pattern, so add it with an explicit path only if ever needed, never via `git add -A`).

---

## Task 1: Database schema — pipeline tracking mode, pipeline runs, tagged deployments

**Files:**
- Modify: `server/src/db/schema.sql`
- Modify: `server/src/db/client.ts`
- Test: `server/src/db/client.test.ts` (create if it doesn't exist — check first)

**Interfaces:**
- Produces: `pipelines.track_components_independently` (INTEGER 0/1, default 1), new `pipeline_runs` table (`id`, `pipeline_id`, `title`, `component_list`, `created_at`), `deployments.pipeline_run_id` (nullable TEXT), `deployments.pipeline_step_index` (nullable INTEGER).

- [ ] **Step 1: Check for an existing db/client test file**

Run: `ls server/src/db/*.test.ts 2>/dev/null || echo "none"`

If one exists, read it fully before continuing so Step 2's test matches its existing style. If none exists, Step 2 creates one from scratch.

- [ ] **Step 2: Write a failing test for the migration**

Create/append to `server/src/db/client.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { openDb, runMigrations } from "./client.js";

describe("runMigrations — pipeline execution columns", () => {
  it("adds track_components_independently to pipelines, defaulting to 1", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare(`INSERT INTO pipelines (id, name, connection_ids) VALUES ('p1', 'Main', '[]')`).run();
    const row = db.prepare(`SELECT track_components_independently FROM pipelines WHERE id = 'p1'`).get() as any;
    expect(row.track_components_independently).toBe(1);
  });

  it("creates the pipeline_runs table", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    db.prepare(
      `INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES ('r1', 'p1', 'Run 1', '[]', '2026-01-01T00:00:00.000Z')`
    ).run();
    const row = db.prepare(`SELECT * FROM pipeline_runs WHERE id = 'r1'`).get() as any;
    expect(row.title).toBe("Run 1");
  });

  it("adds pipeline_run_id and pipeline_step_index to deployments, both nullable", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(deployments)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("pipeline_run_id");
    expect(cols).toContain("pipeline_step_index");
  });

  it("running migrations twice on the same db is a no-op (idempotent)", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info(pipelines)").all() as { name: string }[]).map((c) => c.name);
    expect(cols.filter((c) => c === "track_components_independently")).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && npx vitest run src/db/client.test.ts`
Expected: FAIL — `track_components_independently`/`pipeline_runs`/`pipeline_run_id` don't exist yet.

- [ ] **Step 4: Update `server/src/db/schema.sql`**

Change the `pipelines` table definition to:

```sql
CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connection_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  track_components_independently INTEGER NOT NULL DEFAULT 1
);
```

Add a new table directly after it:

```sql
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  title TEXT,
  component_list TEXT NOT NULL,
  created_at TEXT NOT NULL
);
```

In the `deployments` table definition, add two columns at the end of the column list (right after `run_by TEXT`):

```sql
  run_by TEXT,
  pipeline_run_id TEXT REFERENCES pipeline_runs(id),
  pipeline_step_index INTEGER
);
```

- [ ] **Step 5: Add idempotent migrations in `server/src/db/client.ts`**

Right after the existing `hasStatus` block for `pipelines` (inside `runMigrations`), add:

```typescript
  const hasTrackIndependently = pipelinesColumns.some((col) => col.name === "track_components_independently");
  if (!hasTrackIndependently) {
    db.exec("ALTER TABLE pipelines ADD COLUMN track_components_independently INTEGER NOT NULL DEFAULT 1");
  }
```

Right after the existing `run_by` block for `deployments` (BEFORE the CHECK-rebuild block — additive ALTERs must run before the rebuild since the rebuild copies by the current column list), add:

```typescript
  if (!deploymentsColumns.some((col) => col.name === "pipeline_run_id")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id)`);
  }
  if (!deploymentsColumns.some((col) => col.name === "pipeline_step_index")) {
    db.exec(`ALTER TABLE deployments ADD COLUMN pipeline_step_index INTEGER`);
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server && npx vitest run src/db/client.test.ts`
Expected: PASS (all 4 tests).

- [ ] **Step 7: Run the full server test suite to confirm nothing broke**

Run: `cd server && npx vitest run`
Expected: All existing tests still pass (this is a purely additive schema change).

- [ ] **Step 8: Commit**

```bash
git add server/src/db/schema.sql server/src/db/client.ts server/src/db/client.test.ts
git commit -m "feat: add schema for pipeline runs and tagged deployment steps"
```

---

## Task 2: `pipelines.ts` — support the tracking-mode setting

**Files:**
- Modify: `server/src/pipelines/pipelines.ts`
- Modify: `server/src/pipelines/pipelines.test.ts`

**Interfaces:**
- Consumes: nothing new (schema from Task 1).
- Produces: `Pipeline.trackComponentsIndependently: boolean`; `createPipeline` unchanged signature (always creates with `true`); `updatePipeline(db, id, { name, connectionIds, trackComponentsIndependently? })` — omitting the field preserves the current stored value; `getPipeline(db, id): Pipeline | undefined` (unchanged signature, now includes the new field).

- [ ] **Step 1: Write failing tests**

Add to `server/src/pipelines/pipelines.test.ts`:

```typescript
  it("defaults a new pipeline to tracking components independently", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    expect(created.trackComponentsIndependently).toBe(true);
    expect(getPipeline(db, created.id)!.trackComponentsIndependently).toBe(true);
  });

  it("updates the tracking mode when explicitly provided", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    updatePipeline(db, created.id, { name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });
    expect(getPipeline(db, created.id)!.trackComponentsIndependently).toBe(false);
  });

  it("leaves the tracking mode untouched when the update omits it", () => {
    const db = freshDb();
    const created = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    updatePipeline(db, created.id, { name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });
    updatePipeline(db, created.id, { name: "Renamed", connectionIds: ["a", "b"] });
    expect(getPipeline(db, created.id)!.trackComponentsIndependently).toBe(false);
    expect(getPipeline(db, created.id)!.name).toBe("Renamed");
  });
```

Also add `getPipeline` to the existing `import { ... } from "./pipelines.js"` line at the top of the test file (it isn't imported today even though the function already exists).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/pipelines.test.ts`
Expected: FAIL — `trackComponentsIndependently` is `undefined` on the returned objects.

- [ ] **Step 3: Implement in `server/src/pipelines/pipelines.ts`**

Replace the whole file with:

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
  // Governs how a hop's partial success is handled for every run of this pipeline (see
  // pipelineRuns.ts's deriveComponentPositions): true tracks each component's advancement
  // separately; false holds the whole batch back until a single deploy attempt clears everyone
  // still pending at that hop.
  trackComponentsIndependently: boolean;
}

function rowToPipeline(row: any): Pipeline {
  return {
    id: row.id,
    name: row.name,
    connectionIds: JSON.parse(row.connection_ids),
    status: row.status,
    trackComponentsIndependently: !!row.track_components_independently,
  };
}

const SELECT_COLUMNS = `id, name, connection_ids, status, track_components_independently`;

export function createPipeline(db: Database.Database, input: { name: string; connectionIds: string[] }): Pipeline {
  const id = randomUUID();
  db.prepare(`INSERT INTO pipelines (id, name, connection_ids, status, track_components_independently) VALUES (?, ?, ?, 'active', 1)`).run(
    id,
    input.name,
    JSON.stringify(input.connectionIds)
  );
  return { id, name: input.name, connectionIds: input.connectionIds, status: "active", trackComponentsIndependently: true };
}

export function listPipelines(db: Database.Database): Pipeline[] {
  return db.prepare(`SELECT ${SELECT_COLUMNS} FROM pipelines`).all().map(rowToPipeline);
}

export function getPipeline(db: Database.Database, id: string): Pipeline | undefined {
  const row = db.prepare(`SELECT ${SELECT_COLUMNS} FROM pipelines WHERE id = ?`).get(id) as any;
  return row ? rowToPipeline(row) : undefined;
}

export function updatePipeline(
  db: Database.Database,
  id: string,
  input: { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean }
): boolean {
  // Omitting trackComponentsIndependently must leave the stored value untouched (e.g. a plain
  // rename shouldn't silently reset the tracking mode) — COALESCE keeps the existing value when
  // the bound parameter is NULL.
  const trackValue = input.trackComponentsIndependently === undefined ? null : input.trackComponentsIndependently ? 1 : 0;
  const result = db
    .prepare(
      `UPDATE pipelines SET name = ?, connection_ids = ?, track_components_independently = COALESCE(?, track_components_independently) WHERE id = ?`
    )
    .run(input.name, JSON.stringify(input.connectionIds), trackValue, id);
  return result.changes > 0;
}

export function setPipelineStatus(db: Database.Database, id: string, status: "active" | "closed"): boolean {
  const result = db.prepare(`UPDATE pipelines SET status = ? WHERE id = ?`).run(status, id);
  return result.changes > 0;
}

export function deletePipeline(db: Database.Database, id: string): boolean {
  const result = db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  return result.changes > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/pipelines.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add server/src/pipelines/pipelines.ts server/src/pipelines/pipelines.test.ts
git commit -m "feat: add per-pipeline component-tracking mode setting"
```

---

## Task 3: Pipeline routes — single-pipeline fetch, extended update

**Files:**
- Modify: `server/src/pipelines/routes.ts`
- Modify: `server/src/pipelines/routes.test.ts`

**Interfaces:**
- Consumes: `getPipeline`, `updatePipeline` from Task 2.
- Produces: `GET /api/pipelines/:id` → 200 `Pipeline` or 404; `PUT /api/pipelines/:id` body now accepts an optional `trackComponentsIndependently: boolean`.

- [ ] **Step 1: Write failing tests**

Add to `server/src/pipelines/routes.test.ts`:

```typescript
  it("fetches a single pipeline by id", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });

    const res = await request(app).get(`/api/pipelines/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Main");
    expect(res.body.trackComponentsIndependently).toBe(true);
  });

  it("returns 404 for a single-pipeline lookup on an unknown id", async () => {
    const { app } = buildApp();
    const res = await request(app).get("/api/pipelines/nonexistent-id");
    expect(res.status).toBe(404);
  });

  it("updates the tracking mode via PUT when provided", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });

    const res = await request(app)
      .put(`/api/pipelines/${created.body.id}`)
      .send({ name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });

    expect(res.status).toBe(200);
    expect(res.body.trackComponentsIndependently).toBe(false);
  });

  it("leaves the tracking mode unchanged via PUT when omitted", async () => {
    const { app } = buildApp();
    const created = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });
    await request(app)
      .put(`/api/pipelines/${created.body.id}`)
      .send({ name: "Main", connectionIds: ["a", "b"], trackComponentsIndependently: false });

    const res = await request(app).put(`/api/pipelines/${created.body.id}`).send({ name: "Renamed", connectionIds: ["a", "b"] });
    expect(res.body.trackComponentsIndependently).toBe(false);
    expect(res.body.name).toBe("Renamed");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/routes.test.ts`
Expected: FAIL — `GET /api/pipelines/:id` doesn't exist (404 for all of them, including the "should be 200" case), and PUT ignores `trackComponentsIndependently`.

- [ ] **Step 3: Implement in `server/src/pipelines/routes.ts`**

Add `getPipeline` is already imported. Add a new route right before the `PUT` route:

```typescript
  router.get("/api/pipelines/:id", (req, res) => {
    const pipeline = getPipeline(db, req.params.id);
    if (!pipeline) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.json(pipeline);
  });
```

Update `validatePipelineBody` to also extract and pass through the optional field:

```typescript
function validatePipelineBody(
  body: unknown
): { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "request body must be a JSON object" };
  const { name, connectionIds, trackComponentsIndependently } = body as {
    name?: unknown;
    connectionIds?: unknown;
    trackComponentsIndependently?: unknown;
  };
  if (typeof name !== "string" || name.trim() === "") return { error: "name is required and must be a non-empty string" };
  if (!Array.isArray(connectionIds) || connectionIds.some((id) => typeof id !== "string")) {
    return { error: "connectionIds is required and must be an array of strings" };
  }
  if (trackComponentsIndependently !== undefined && typeof trackComponentsIndependently !== "boolean") {
    return { error: "trackComponentsIndependently must be a boolean when provided" };
  }
  return { name, connectionIds: connectionIds as string[], trackComponentsIndependently: trackComponentsIndependently as boolean | undefined };
}
```

Update the `PUT` handler to pass the new field through:

```typescript
  router.put("/api/pipelines/:id", (req, res) => {
    const validated = validatePipelineBody(req.body);
    if ("error" in validated) {
      res.status(400).json({ error: validated.error });
      return;
    }
    const { name, connectionIds, trackComponentsIndependently } = validated;
    const updated = updatePipeline(db, req.params.id, { name, connectionIds, trackComponentsIndependently });
    if (!updated) {
      res.status(404).json({ error: "pipeline not found" });
      return;
    }
    res.status(200).json(getPipeline(db, req.params.id));
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/routes.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/pipelines/routes.ts server/src/pipelines/routes.test.ts
git commit -m "feat: add single-pipeline fetch route and tracking-mode update"
```

---

## Task 4: `pipelineRuns.ts` — the position/eligibility derivation (pure, no DB)

This is the one piece of genuinely new logic in the whole feature, so it gets the most direct test coverage of any task in this plan.

**Files:**
- Create: `server/src/pipelines/pipelineRuns.ts`
- Create: `server/src/pipelines/pipelineRuns.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface PipelineRunComponent { type: string; fullName: string }

  export interface StepDeploymentItem {
    metadataType: string;
    apiName: string;
    status: "pending" | "succeeded" | "failed";
  }

  export interface StepDeployment {
    stepIndex: number;
    status: string; // deployments.status
    validateOnly: boolean;
    finishedAt: string | null;
    items: StepDeploymentItem[];
  }

  export interface ComponentPosition {
    type: string;
    fullName: string;
    stage: number; // 0-based index into the pipeline's connectionIds; 0 = not yet promoted anywhere
    reachedAt: string | null; // finished_at of the deployment that most recently advanced it here; null at stage 0
  }

  export function deriveComponentPositions(
    components: PipelineRunComponent[],
    deployments: StepDeployment[],
    trackIndependently: boolean
  ): ComponentPosition[]
  ```

- [ ] **Step 1: Write the failing tests**

Create `server/src/pipelines/pipelineRuns.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { deriveComponentPositions, type StepDeployment } from "./pipelineRuns.js";

const COMPONENTS = [
  { type: "ApexClass", fullName: "A" },
  { type: "ApexClass", fullName: "B" },
];

describe("deriveComponentPositions", () => {
  it("leaves every component at stage 0 with no deployments yet", () => {
    const result = deriveComponentPositions(COMPONENTS, [], true);
    expect(result).toEqual([
      { type: "ApexClass", fullName: "A", stage: 0, reachedAt: null },
      { type: "ApexClass", fullName: "B", stage: 0, reachedAt: null },
    ]);
  });

  it("advances a component past a step it succeeded in", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "succeeded" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result).toEqual([
      { type: "ApexClass", fullName: "A", stage: 1, reachedAt: "2026-01-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "B", stage: 1, reachedAt: "2026-01-01T00:00:00.000Z" },
    ]);
  });

  it("treats a component absent from a step's deployment as an automatic pass-through (already unchanged there)", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
        // B was already identical at this hop, so the diff never selected it — no item for B here.
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "B")).toEqual({
      type: "ApexClass",
      fullName: "B",
      stage: 1,
      reachedAt: "2026-01-01T00:00:00.000Z",
    });
  });

  it("never advances a component past a step where its item failed", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "failed" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")).toEqual({ type: "ApexClass", fullName: "A", stage: 0, reachedAt: null });
  });

  it("ignores a validate-only deployment entirely — it never advances anyone", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: true,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.every((p) => p.stage === 0)).toBe(true);
  });

  it("in independent mode, a later retry can advance a component that failed an earlier attempt at the same step", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "failed" }],
      },
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-02T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")).toEqual({
      type: "ApexClass",
      fullName: "A",
      stage: 1,
      reachedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("in independent mode, one component's failure at a step never blocks another component that succeeded the same step", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "failed" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, true);
    expect(result.find((p) => p.fullName === "A")!.stage).toBe(0);
    expect(result.find((p) => p.fullName === "B")!.stage).toBe(1);
  });

  it("in blocked mode, one component's failure holds back even the components that individually succeeded the same attempt", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "failed" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, false);
    expect(result.find((p) => p.fullName === "A")!.stage).toBe(0);
    expect(result.find((p) => p.fullName === "B")!.stage).toBe(0);
  });

  it("in blocked mode, a later attempt that clears everyone still pending advances the whole batch together", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "failed",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [
          { metadataType: "ApexClass", apiName: "A", status: "failed" },
          { metadataType: "ApexClass", apiName: "B", status: "succeeded" },
        ],
      },
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-02T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
        // B isn't in this retry's items at all — it was already fine, so only A was re-deployed —
        // but B still counts as "cleared" by this attempt since it has no failing item in it.
      },
    ];
    const result = deriveComponentPositions(COMPONENTS, deployments, false);
    expect(result.find((p) => p.fullName === "A")).toEqual({
      type: "ApexClass",
      fullName: "A",
      stage: 1,
      reachedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(result.find((p) => p.fullName === "B")).toEqual({
      type: "ApexClass",
      fullName: "B",
      stage: 1,
      reachedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("advances a component through multiple consecutive steps", () => {
    const deployments: StepDeployment[] = [
      {
        stepIndex: 0,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-01T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
      {
        stepIndex: 1,
        status: "succeeded",
        validateOnly: false,
        finishedAt: "2026-01-02T00:00:00.000Z",
        items: [{ metadataType: "ApexClass", apiName: "A", status: "succeeded" }],
      },
    ];
    const result = deriveComponentPositions([{ type: "ApexClass", fullName: "A" }], deployments, true);
    expect(result).toEqual([{ type: "ApexClass", fullName: "A", stage: 2, reachedAt: "2026-01-02T00:00:00.000Z" }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `server/src/pipelines/pipelineRuns.ts`**

```typescript
export interface PipelineRunComponent {
  type: string;
  fullName: string;
}

export interface StepDeploymentItem {
  metadataType: string;
  apiName: string;
  status: "pending" | "succeeded" | "failed";
}

export interface StepDeployment {
  stepIndex: number;
  status: string;
  validateOnly: boolean;
  finishedAt: string | null;
  items: StepDeploymentItem[];
}

export interface ComponentPosition {
  type: string;
  fullName: string;
  stage: number;
  reachedAt: string | null;
}

function componentKey(c: { type: string; fullName: string }): string {
  return `${c.type}::${c.fullName}`;
}

function itemKey(i: StepDeploymentItem): string {
  return `${i.metadataType}::${i.apiName}`;
}

/**
 * Computes each component's current stage in a pipeline run and when it got there, purely from
 * the run's tagged deployments — there is no separate "position" table (see the design spec).
 *
 * A component only advances past step N via a succeeded, non-validate-only deployment tagged to
 * that step: either it has a succeeded item there, or it has NO item there at all (the hop's diff
 * found it already identical, so it needed no action and passes straight through). A failed item
 * leaves it at the same stage, retryable by a later deployment tagged to the same step.
 *
 * trackIndependently=false additionally requires that a SINGLE attempt clear every component
 * still pending at a step before ANY of them advance — even ones that individually succeeded in
 * an attempt that also had a failure stay behind until a fully-clean attempt promotes the whole
 * batch together.
 */
export function deriveComponentPositions(
  components: PipelineRunComponent[],
  deployments: StepDeployment[],
  trackIndependently: boolean
): ComponentPosition[] {
  const positions = new Map<string, ComponentPosition>(
    components.map((c) => [componentKey(c), { type: c.type, fullName: c.fullName, stage: 0, reachedAt: null }])
  );

  const maxStep = deployments.reduce((max, d) => Math.max(max, d.stepIndex), -1);

  for (let stepIndex = 0; stepIndex <= maxStep; stepIndex++) {
    const attempts = deployments
      .filter((d) => d.stepIndex === stepIndex && d.status === "succeeded" && !d.validateOnly)
      .sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
    if (attempts.length === 0) continue;

    const pendingKeys = [...positions.values()].filter((p) => p.stage === stepIndex).map((p) => componentKey(p));
    if (pendingKeys.length === 0) continue;

    if (trackIndependently) {
      for (const attempt of attempts) {
        for (const key of pendingKeys) {
          const pos = positions.get(key)!;
          if (pos.stage !== stepIndex) continue; // an earlier attempt in this same loop already advanced it
          const item = attempt.items.find((i) => itemKey(i) === key);
          if (!item || item.status === "succeeded") {
            pos.stage = stepIndex + 1;
            pos.reachedAt = attempt.finishedAt;
          }
        }
      }
    } else {
      for (const attempt of attempts) {
        const stillPending = pendingKeys.filter((key) => positions.get(key)!.stage === stepIndex);
        if (stillPending.length === 0) break;
        const allClear = stillPending.every((key) => {
          const item = attempt.items.find((i) => itemKey(i) === key);
          return !item || item.status === "succeeded";
        });
        if (allClear) {
          for (const key of stillPending) {
            const pos = positions.get(key)!;
            pos.stage = stepIndex + 1;
            pos.reachedAt = attempt.finishedAt;
          }
          break;
        }
      }
    }
  }

  return [...positions.values()];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: PASS (all 11 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/pipelines/pipelineRuns.ts server/src/pipelines/pipelineRuns.test.ts
git commit -m "feat: add pure component-position derivation for pipeline runs"
```

---

## Task 5: `pipelineRuns.ts` — create and list runs

**Files:**
- Modify: `server/src/pipelines/pipelineRuns.ts`
- Modify: `server/src/pipelines/pipelineRuns.test.ts`

**Interfaces:**
- Consumes: `getPipeline` from `./pipelines.js`; `deriveComponentPositions` from Task 4.
- Produces:
  ```typescript
  export interface PipelineRunSummary {
    id: string;
    pipelineId: string;
    title: string | null;
    createdAt: string;
    componentCount: number;
    componentsAtFinalStage: number;
  }

  export function createPipelineRun(
    db: Database.Database,
    input: { pipelineId: string; title?: string; components: PipelineRunComponent[] }
  ): { id: string }

  export function listPipelineRuns(db: Database.Database, pipelineId: string): PipelineRunSummary[]
  ```
  `createPipelineRun` throws `Error` if the pipeline doesn't exist, has fewer than 2 connections, or `components` is empty.

- [ ] **Step 1: Write failing tests**

Add to `server/src/pipelines/pipelineRuns.test.ts` (new imports at top: `import { openDb, runMigrations } from "../db/client.js"; import { createPipeline } from "./pipelines.js"; import { createPipelineRun, listPipelineRuns } from "./pipelineRuns.js";` alongside the existing `deriveComponentPositions` import):

```typescript
function freshDb() {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

describe("createPipelineRun", () => {
  it("creates a run with the given components", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    const { id } = createPipelineRun(db, {
      pipelineId: pipeline.id,
      title: "January batch",
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });
    expect(id).toBeTruthy();
  });

  it("throws for an unknown pipeline", () => {
    const db = freshDb();
    expect(() => createPipelineRun(db, { pipelineId: "nope", components: [{ type: "ApexClass", fullName: "A" }] })).toThrow(
      /no pipeline/i
    );
  });

  it("throws for a pipeline with fewer than 2 connections", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Solo", connectionIds: ["a"] });
    expect(() => createPipelineRun(db, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "A" }] })).toThrow(
      /at least two connections/i
    );
  });

  it("throws for an empty component list", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b"] });
    expect(() => createPipelineRun(db, { pipelineId: pipeline.id, components: [] })).toThrow(/at least one component/i);
  });
});

describe("listPipelineRuns", () => {
  it("lists runs for a pipeline, most recent first, with a component-count summary", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b", "c"] });
    createPipelineRun(db, { pipelineId: pipeline.id, title: "First", components: [{ type: "ApexClass", fullName: "A" }] });
    createPipelineRun(db, {
      pipelineId: pipeline.id,
      title: "Second",
      components: [
        { type: "ApexClass", fullName: "B" },
        { type: "ApexClass", fullName: "C" },
      ],
    });

    const runs = listPipelineRuns(db, pipeline.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].title).toBe("Second");
    expect(runs[0].componentCount).toBe(2);
    expect(runs[0].componentsAtFinalStage).toBe(0);
    expect(runs[1].title).toBe("First");
  });

  it("does not mix runs belonging to a different pipeline", () => {
    const db = freshDb();
    const pipelineA = createPipeline(db, { name: "A", connectionIds: ["a", "b"] });
    const pipelineB = createPipeline(db, { name: "B", connectionIds: ["c", "d"] });
    createPipelineRun(db, { pipelineId: pipelineA.id, components: [{ type: "ApexClass", fullName: "X" }] });
    createPipelineRun(db, { pipelineId: pipelineB.id, components: [{ type: "ApexClass", fullName: "Y" }] });

    expect(listPipelineRuns(db, pipelineA.id)).toHaveLength(1);
    expect(listPipelineRuns(db, pipelineB.id)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: FAIL — `createPipelineRun`/`listPipelineRuns` don't exist yet.

- [ ] **Step 3: Implement**

Add to the top of `server/src/pipelines/pipelineRuns.ts`:

```typescript
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getPipeline } from "./pipelines.js";
```

Add at the end of the file:

```typescript
export interface PipelineRunSummary {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentCount: number;
  componentsAtFinalStage: number;
}

export function createPipelineRun(
  db: Database.Database,
  input: { pipelineId: string; title?: string; components: PipelineRunComponent[] }
): { id: string } {
  const pipeline = getPipeline(db, input.pipelineId);
  if (!pipeline) throw new Error(`No pipeline with id ${input.pipelineId}`);
  if (pipeline.connectionIds.length < 2) throw new Error("Pipeline must have at least two connections to run");
  if (input.components.length === 0) throw new Error("A run needs at least one component");

  const id = randomUUID();
  db.prepare(`INSERT INTO pipeline_runs (id, pipeline_id, title, component_list, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    id,
    input.pipelineId,
    input.title ?? null,
    JSON.stringify(input.components),
    new Date().toISOString()
  );
  return { id };
}

// Bulk-fetches every run's tagged deployments (plus their items) in two queries total, regardless
// of how many runs there are — the same N+1-avoidance pattern already used by listDeployments()
// for the History page.
function loadStepDeploymentsByRun(db: Database.Database, runIds: string[]): Map<string, StepDeployment[]> {
  const result = new Map<string, StepDeployment[]>();
  if (runIds.length === 0) return result;

  const placeholders = runIds.map(() => "?").join(",");
  const deploymentRows = db
    .prepare(`SELECT id, pipeline_run_id, pipeline_step_index, status, validate_only, finished_at FROM deployments WHERE pipeline_run_id IN (${placeholders})`)
    .all(...runIds) as any[];
  if (deploymentRows.length === 0) return result;

  const deploymentIds = deploymentRows.map((d) => d.id);
  const itemPlaceholders = deploymentIds.map(() => "?").join(",");
  const itemRows = db
    .prepare(`SELECT deployment_id, metadata_type, api_name, status FROM deployment_items WHERE deployment_id IN (${itemPlaceholders})`)
    .all(...deploymentIds) as any[];
  const itemsByDeployment = new Map<string, StepDeploymentItem[]>();
  for (const item of itemRows) {
    const bucket = itemsByDeployment.get(item.deployment_id);
    const entry = { metadataType: item.metadata_type, apiName: item.api_name, status: item.status };
    if (bucket) bucket.push(entry);
    else itemsByDeployment.set(item.deployment_id, [entry]);
  }

  for (const row of deploymentRows) {
    const stepDeployment: StepDeployment = {
      stepIndex: row.pipeline_step_index,
      status: row.status,
      validateOnly: !!row.validate_only,
      finishedAt: row.finished_at,
      items: itemsByDeployment.get(row.id) ?? [],
    };
    const bucket = result.get(row.pipeline_run_id);
    if (bucket) bucket.push(stepDeployment);
    else result.set(row.pipeline_run_id, [stepDeployment]);
  }
  return result;
}

export function listPipelineRuns(db: Database.Database, pipelineId: string): PipelineRunSummary[] {
  const pipeline = getPipeline(db, pipelineId);
  const runRows = db
    .prepare(`SELECT id, title, component_list, created_at FROM pipeline_runs WHERE pipeline_id = ? ORDER BY created_at DESC`)
    .all(pipelineId) as any[];
  const deploymentsByRun = loadStepDeploymentsByRun(db, runRows.map((r) => r.id));
  const finalStage = pipeline ? pipeline.connectionIds.length - 1 : 0;
  const trackIndependently = pipeline?.trackComponentsIndependently ?? true;

  return runRows.map((row) => {
    const components: PipelineRunComponent[] = JSON.parse(row.component_list);
    const positions = deriveComponentPositions(components, deploymentsByRun.get(row.id) ?? [], trackIndependently);
    return {
      id: row.id,
      pipelineId,
      title: row.title,
      createdAt: row.created_at,
      componentCount: components.length,
      componentsAtFinalStage: positions.filter((p) => p.stage >= finalStage).length,
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/pipelines/pipelineRuns.ts server/src/pipelines/pipelineRuns.test.ts
git commit -m "feat: add pipeline run creation and bulk-fetched run listing"
```

---

## Task 6: `pipelineRuns.ts` — full run detail

**Files:**
- Modify: `server/src/pipelines/pipelineRuns.ts`
- Modify: `server/src/pipelines/pipelineRuns.test.ts`

**Interfaces:**
- Consumes: `getPipeline`, `deriveComponentPositions`, `loadStepDeploymentsByRun` (already private to this file) from earlier tasks/steps in this same file.
- Produces:
  ```typescript
  export interface PipelineRunDetail {
    id: string;
    pipelineId: string;
    title: string | null;
    createdAt: string;
    componentList: PipelineRunComponent[];
    connectionIds: string[];
    trackComponentsIndependently: boolean;
    deployments: (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[];
    positions: ComponentPosition[];
  }

  export function getPipelineRunDetail(db: Database.Database, runId: string): PipelineRunDetail | undefined
  ```

- [ ] **Step 1: Write failing tests**

Add to `server/src/pipelines/pipelineRuns.test.ts` (add `getPipelineRunDetail` to the existing import from `./pipelineRuns.js`):

```typescript
describe("getPipelineRunDetail", () => {
  it("returns undefined for an unknown run", () => {
    const db = freshDb();
    expect(getPipelineRunDetail(db, "nonexistent")).toBeUndefined();
  });

  it("returns the run's pipeline context, component list, and derived positions", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b", "c"] });
    const { id: runId } = createPipelineRun(db, {
      pipelineId: pipeline.id,
      title: "Batch 1",
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });

    const detail = getPipelineRunDetail(db, runId)!;
    expect(detail.pipelineId).toBe(pipeline.id);
    expect(detail.connectionIds).toEqual(["a", "b", "c"]);
    expect(detail.trackComponentsIndependently).toBe(true);
    expect(detail.componentList).toEqual([{ type: "ApexClass", fullName: "MyClass" }]);
    expect(detail.deployments).toEqual([]);
    expect(detail.positions).toEqual([{ type: "ApexClass", fullName: "MyClass", stage: 0, reachedAt: null }]);
  });

  it("includes tagged deployments with their items, ordered by step then start time", () => {
    const db = freshDb();
    const pipeline = createPipeline(db, { name: "Main", connectionIds: ["a", "b", "c"] });
    const { id: runId } = createPipelineRun(db, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO deployments (id, source_connection_id, target_connection_id, component_list, test_level, status, validate_only, started_at, finished_at, pipeline_run_id, pipeline_step_index)
       VALUES ('d1', 'a', 'b', '[]', 'NoTestRun', 'succeeded', 0, ?, ?, ?, 0)`
    ).run(now, now, runId);
    db.prepare(
      `INSERT INTO deployment_items (id, deployment_id, metadata_type, api_name, action, status) VALUES ('i1', 'd1', 'ApexClass', 'MyClass', 'modify', 'succeeded')`
    ).run();

    const detail = getPipelineRunDetail(db, runId)!;
    expect(detail.deployments).toHaveLength(1);
    expect(detail.deployments[0]).toMatchObject({ id: "d1", stepIndex: 0, status: "succeeded" });
    expect(detail.deployments[0].items).toEqual([{ metadataType: "ApexClass", apiName: "MyClass", status: "succeeded" }]);
    expect(detail.positions[0].stage).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: FAIL — `getPipelineRunDetail` doesn't exist.

- [ ] **Step 3: Implement**

Add at the end of `server/src/pipelines/pipelineRuns.ts`. Note this needs `id`/`started_at`/`error_detail` per deployment, which `loadStepDeploymentsByRun`'s query doesn't currently select — extend that query rather than writing a second one:

Change `loadStepDeploymentsByRun`'s SELECT from:

```typescript
    .prepare(`SELECT id, pipeline_run_id, pipeline_step_index, status, validate_only, finished_at FROM deployments WHERE pipeline_run_id IN (${placeholders})`)
```

to:

```typescript
    .prepare(`SELECT id, pipeline_run_id, pipeline_step_index, status, validate_only, started_at, finished_at, error_detail FROM deployments WHERE pipeline_run_id IN (${placeholders}) ORDER BY pipeline_step_index ASC, started_at ASC`)
```

Change the `stepDeployment` object built inside its loop from:

```typescript
    const stepDeployment: StepDeployment = {
      stepIndex: row.pipeline_step_index,
      status: row.status,
      validateOnly: !!row.validate_only,
      finishedAt: row.finished_at,
      items: itemsByDeployment.get(row.id) ?? [],
    };
```

to:

```typescript
    const stepDeployment: StepDeployment & { id: string; startedAt: string; errorDetail: string | null } = {
      id: row.id,
      stepIndex: row.pipeline_step_index,
      status: row.status,
      validateOnly: !!row.validate_only,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      errorDetail: row.error_detail,
      items: itemsByDeployment.get(row.id) ?? [],
    };
```

(This makes the map's value type `(StepDeployment & { id, startedAt, errorDetail })[]` — update the `Map<string, StepDeployment[]>` declarations at the top of `loadStepDeploymentsByRun` to `Map<string, (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[]>`, and the same for its `result`/`bucket` locals. `listPipelineRuns`'s usage of this map is unaffected since it only reads fields already on `StepDeployment`.)

Now add the new export:

```typescript
export interface PipelineRunDetail {
  id: string;
  pipelineId: string;
  title: string | null;
  createdAt: string;
  componentList: PipelineRunComponent[];
  connectionIds: string[];
  trackComponentsIndependently: boolean;
  deployments: (StepDeployment & { id: string; startedAt: string; errorDetail: string | null })[];
  positions: ComponentPosition[];
}

export function getPipelineRunDetail(db: Database.Database, runId: string): PipelineRunDetail | undefined {
  const row = db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(runId) as any;
  if (!row) return undefined;
  const pipeline = getPipeline(db, row.pipeline_id);
  if (!pipeline) return undefined;

  const componentList: PipelineRunComponent[] = JSON.parse(row.component_list);
  const deployments = loadStepDeploymentsByRun(db, [runId]).get(runId) ?? [];
  const positions = deriveComponentPositions(componentList, deployments, pipeline.trackComponentsIndependently);

  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    title: row.title,
    createdAt: row.created_at,
    componentList,
    connectionIds: pipeline.connectionIds,
    trackComponentsIndependently: pipeline.trackComponentsIndependently,
    deployments,
    positions,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: PASS (all tests, including Task 5's).

- [ ] **Step 5: Commit**

```bash
git add server/src/pipelines/pipelineRuns.ts server/src/pipelines/pipelineRuns.test.ts
git commit -m "feat: add full pipeline run detail with derived positions"
```

---

## Task 7: `pipelineRuns.ts` — the deploy-a-step orchestration

**Files:**
- Modify: `server/src/pipelines/pipelineRuns.ts`
- Modify: `server/src/pipelines/pipelineRuns.test.ts`
- Modify: `server/src/engine/deploy.ts` (one small helper)
- Modify: `server/src/engine/deploy.test.ts`

**Interfaces:**
- Consumes: `resolveComponents` from `../engine/routes.js`; `diffComponents` from `../engine/diff.js`; `createDraftDeployment`, `attachComponentsAndQueue`, `setRunBy`, `runDeployment` from `../engine/deploy.js`; `getPipelineRunDetail` (this file, Task 6).
- Produces:
  ```typescript
  // engine/deploy.ts
  export function tagDeploymentToPipelineStep(db: Database.Database, deploymentId: string, pipelineRunId: string, stepIndex: number): void

  // pipelineRuns.ts
  export async function deployPipelineStep(
    db: Database.Database,
    config: Config,
    dataDir: string,
    runId: string,
    stepIndex: number,
    options: { validateOnly: boolean; runBy?: string | null }
  ): Promise<{ deploymentId: string; skipped: boolean }>
  ```
  Throws a plain `Error` (never resolves to a `{ok:false}` shape) for: unknown run, `stepIndex` out of range, or no components currently eligible for that step. This matches `rollbackDeployment`'s existing throw-based contract, which its route already catches into a 400.

- [ ] **Step 1: Add the tagging helper to `engine/deploy.ts` with a failing test first**

Add to `server/src/engine/deploy.test.ts` (near the other small helper tests — the file already imports `getDeployment`, add `tagDeploymentToPipelineStep` to that same import line):

```typescript
describe("tagDeploymentToPipelineStep", () => {
  it("sets pipeline_run_id and pipeline_step_index on the deployment row", () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const id = createDraftDeployment(db, { sourceConnectionId: source.id, targetConnectionId: target.id });

    tagDeploymentToPipelineStep(db, id, "run-123", 2);

    const row = getDeployment(db, id)!;
    expect(row.pipeline_run_id).toBe("run-123");
    expect(row.pipeline_step_index).toBe(2);
  });
});
```

Run: `cd server && npx vitest run src/engine/deploy.test.ts -t tagDeploymentToPipelineStep`
Expected: FAIL — not exported yet.

Add to `server/src/engine/deploy.ts`, right after `setRunBy`:

```typescript
/** Marks a deployment as belonging to a specific hop of a pipeline run — see pipelineRuns.ts. */
export function tagDeploymentToPipelineStep(db: Database.Database, deploymentId: string, pipelineRunId: string, stepIndex: number): void {
  db.prepare(`UPDATE deployments SET pipeline_run_id = ?, pipeline_step_index = ? WHERE id = ?`).run(pipelineRunId, stepIndex, deploymentId);
}
```

Run: `cd server && npx vitest run src/engine/deploy.test.ts -t tagDeploymentToPipelineStep`
Expected: PASS.

- [ ] **Step 2: Write failing tests for `deployPipelineStep`**

Add to `server/src/pipelines/pipelineRuns.test.ts`. This needs the same mocking approach `engine/routes.test.ts` uses for diff/deploy calls — add these imports at the top of the test file:

```typescript
import * as engineRoutes from "../engine/routes.js";
import * as deploy from "../engine/deploy.js";
import { createOrgConnection } from "../connections/orgConnections.js";
import type { Config } from "../config.js";
```

and add `deployPipelineStep` to the existing `from "./pipelineRuns.js"` import.

```typescript
describe("deployPipelineStep", () => {
  const config: Config = {
    port: 3000,
    dbPath: ":memory:",
    encryptionKey: "e".repeat(64),
    oauthCallbackUrl: "https://x/oauth/callback",
    sfClientId: "3MVG9fake",
  };

  it("diffs only the eligible components, creates a tagged deployment, and runs it", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = createPipeline(db, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = createPipelineRun(db, {
      pipelineId: pipeline.id,
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });

    vi.spyOn(engineRoutes, "resolveComponents").mockImplementation(async (_db, _cfg, _dir, connectionId) =>
      connectionId === source.id
        ? { kind: "org", components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01" }] }
        : { kind: "org", components: [] }
    );
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const result = await deployPipelineStep(db, config, "/tmp/data", runId, 0, { validateOnly: false });

    expect(result.skipped).toBe(false);
    expect(runSpy).toHaveBeenCalledWith(db, config, "/tmp/data", result.deploymentId);
    const detail = getPipelineRunDetail(db, runId)!;
    expect(detail.deployments).toHaveLength(1);
    expect(detail.deployments[0].stepIndex).toBe(0);
  });

  it("marks a step succeeded without touching Salesforce when every eligible component is already unchanged", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = createPipeline(db, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = createPipelineRun(db, {
      pipelineId: pipeline.id,
      components: [{ type: "ApexClass", fullName: "MyClass" }],
    });

    vi.spyOn(engineRoutes, "resolveComponents").mockResolvedValue({
      kind: "org",
      components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01" }],
    });
    const runSpy = vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

    const result = await deployPipelineStep(db, config, "/tmp/data", runId, 0, { validateOnly: false });

    expect(result.skipped).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
    const detail = getPipelineRunDetail(db, runId)!;
    expect(detail.deployments[0].status).toBe("succeeded");
    expect(detail.positions[0].stage).toBe(1);
  });

  it("throws when no components are eligible for the requested step", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const finalTarget = createOrgConnection(db, { nickname: "Prod", orgType: "production", instanceUrl: "https://z", refreshToken: "r", clientId: "c" });
    const pipeline = createPipeline(db, { name: "Main", connectionIds: [source.id, target.id, finalTarget.id] });
    const { id: runId } = createPipelineRun(db, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    // Nobody has succeeded step 0 yet, so step 1 (QA -> Prod) has nothing eligible.
    await expect(deployPipelineStep(db, config, "/tmp/data", runId, 1, { validateOnly: false })).rejects.toThrow(/no components/i);
  });

  it("throws for an out-of-range step index", async () => {
    const db = freshDb();
    const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
    const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
    const pipeline = createPipeline(db, { name: "Main", connectionIds: [source.id, target.id] });
    const { id: runId } = createPipelineRun(db, { pipelineId: pipeline.id, components: [{ type: "ApexClass", fullName: "MyClass" }] });

    await expect(deployPipelineStep(db, config, "/tmp/data", runId, 5, { validateOnly: false })).rejects.toThrow(/step/i);
  });

  it("throws for an unknown run", async () => {
    const db = freshDb();
    await expect(deployPipelineStep(db, config, "/tmp/data", "nonexistent", 0, { validateOnly: false })).rejects.toThrow(/no pipeline run/i);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts`
Expected: FAIL — `deployPipelineStep` doesn't exist.

- [ ] **Step 4: Implement `deployPipelineStep`**

Add these imports to the top of `server/src/pipelines/pipelineRuns.ts`:

```typescript
import type { Config } from "../config.js";
import { resolveComponents } from "../engine/routes.js";
import { diffComponents } from "../engine/diff.js";
import { createDraftDeployment, attachComponentsAndQueue, setRunBy, runDeployment, tagDeploymentToPipelineStep, type DeployComponentSelection } from "../engine/deploy.js";
```

Add at the end of the file:

```typescript
function actionForDiffStatus(status: "added" | "modified" | "removed" | "unchanged"): "add" | "modify" | "delete" {
  if (status === "added") return "add";
  if (status === "removed") return "delete";
  return "modify";
}

/**
 * Validates/deploys one hop of a pipeline run. Diffs only the components currently eligible for
 * this step (see deriveComponentPositions), creates a normal deployment tagged to the run/step,
 * and either runs it for real or — if the diff shows nothing actually needs to move — marks it
 * succeeded immediately without ever contacting Salesforce, so the derivation function still has
 * a tagged "this step was checked and cleared" record to read.
 */
export async function deployPipelineStep(
  db: Database.Database,
  config: Config,
  dataDir: string,
  runId: string,
  stepIndex: number,
  options: { validateOnly: boolean; runBy?: string | null }
): Promise<{ deploymentId: string; skipped: boolean }> {
  const run = getPipelineRunDetail(db, runId);
  if (!run) throw new Error(`No pipeline run with id ${runId}`);
  if (stepIndex < 0 || stepIndex >= run.connectionIds.length - 1) {
    throw new Error(`step ${stepIndex} is out of range for a pipeline with ${run.connectionIds.length} stages`);
  }

  const eligible = run.positions.filter((p) => p.stage === stepIndex);
  if (eligible.length === 0) {
    throw new Error("No components are eligible for this step yet — they haven't succeeded the previous hop.");
  }

  const sourceId = run.connectionIds[stepIndex];
  const targetId = run.connectionIds[stepIndex + 1];
  const types = [...new Set(eligible.map((c) => c.type))];
  const eligibleKeys = new Set(eligible.map((c) => `${c.type}::${c.fullName}`));

  const [source, target] = await Promise.all([
    resolveComponents(db, config, dataDir, sourceId, types),
    resolveComponents(db, config, dataDir, targetId, types),
  ]);
  const diff = diffComponents(source.components, target.components).filter(
    (d) => eligibleKeys.has(`${d.type}::${d.fullName}`) && d.status !== "unchanged"
  );
  const components: DeployComponentSelection[] = diff.map((d) => ({ type: d.type, fullName: d.fullName, action: actionForDiffStatus(d.status) }));

  const deploymentId = createDraftDeployment(db, {
    title: run.title ? `${run.title} — step ${stepIndex + 1}` : `Pipeline step ${stepIndex + 1}`,
    sourceConnectionId: sourceId,
    targetConnectionId: targetId,
  });
  tagDeploymentToPipelineStep(db, deploymentId, runId, stepIndex);

  if (components.length === 0) {
    // Every eligible component is already identical at this hop — nothing to deploy, so there's
    // nothing to gain by round-tripping to Salesforce with an empty package.
    attachComponentsAndQueue(db, deploymentId, { components: [], testLevel: "NoTestRun", validateOnly: options.validateOnly });
    db.prepare(`UPDATE deployments SET status = 'succeeded', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), deploymentId);
    return { deploymentId, skipped: true };
  }

  attachComponentsAndQueue(db, deploymentId, { components, testLevel: "NoTestRun", validateOnly: options.validateOnly });
  setRunBy(db, deploymentId, options.runBy ?? null);
  runDeployment(db, config, dataDir, deploymentId).catch((err) => {
    console.error(`Pipeline step deployment ${deploymentId} failed unexpectedly`, err);
  });

  return { deploymentId, skipped: false };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/pipelineRuns.test.ts src/engine/deploy.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/pipelines/pipelineRuns.ts server/src/pipelines/pipelineRuns.test.ts server/src/engine/deploy.ts server/src/engine/deploy.test.ts
git commit -m "feat: orchestrate validating/deploying a single pipeline run step"
```

---

## Task 8: Pipeline-run routes + threading `config`/`dataDir` into the pipelines router

**Files:**
- Modify: `server/src/pipelines/routes.ts`
- Modify: `server/src/pipelines/routes.test.ts`
- Modify: `server/src/app.ts`
- Modify: `server/src/app.test.ts` (check whether it constructs `createPipelinesRouter` directly; if so, update the call)

**Interfaces:**
- Consumes: everything from `pipelineRuns.ts` (Tasks 4-7).
- Produces:
  - `createPipelinesRouter(db, config, dataDir)` — signature change (was `(db)`).
  - `POST /api/pipelines/:id/runs` → 201 `{ id }`
  - `GET /api/pipelines/:id/runs` → 200 `PipelineRunSummary[]`
  - `GET /api/pipeline-runs/:runId` → 200 `PipelineRunDetail` or 404
  - `POST /api/pipeline-runs/:runId/steps/:stepIndex/deploy` → 202 `{ deploymentId, skipped }` or 400

- [ ] **Step 1: Check `app.test.ts` for a direct `createPipelinesRouter` call**

Run: `grep -n "createPipelinesRouter" server/src/app.test.ts server/src/app.ts`

Read whatever comes back before continuing — Step 6 below assumes `app.ts` is the only direct caller besides `routes.test.ts`'s own `buildApp` helper; if `app.test.ts` also constructs one directly, its call site needs the same two extra arguments.

- [ ] **Step 2: Write failing tests**

Update `server/src/pipelines/routes.test.ts`'s `buildApp()` helper to pass a fake config and data dir (mirroring `connections/routes.test.ts`'s pattern from earlier work in this codebase):

```typescript
import type { Config } from "../config.js";

const config: Config = {
  port: 3000,
  dbPath: ":memory:",
  encryptionKey: "f".repeat(64),
  oauthCallbackUrl: "https://x/oauth/callback",
  sfClientId: "3MVG9fake",
};

function buildApp() {
  const db = openDb(":memory:");
  runMigrations(db);
  const app = express();
  app.use(express.json());
  app.use(createPipelinesRouter(db, config, "/tmp/pipeline-routes-test"));
  return { app, db };
}
```

Add these tests (add `import * as engineRoutes from "../engine/routes.js"; import * as deploy from "../engine/deploy.js"; import { vi } from "vitest"; import { createOrgConnection } from "../connections/orgConnections.js";` to the top of the file):

```typescript
  describe("pipeline runs", () => {
    it("creates a run via POST and lists it via GET", async () => {
      const { app } = buildApp();
      const pipeline = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });

      const created = await request(app)
        .post(`/api/pipelines/${pipeline.body.id}/runs`)
        .send({ title: "Batch 1", components: [{ type: "ApexClass", fullName: "MyClass" }] });
      expect(created.status).toBe(201);
      expect(created.body.id).toBeTruthy();

      const listed = await request(app).get(`/api/pipelines/${pipeline.body.id}/runs`);
      expect(listed.status).toBe(200);
      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].title).toBe("Batch 1");
    });

    it("rejects creating a run with an empty component list as 400", async () => {
      const { app } = buildApp();
      const pipeline = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });

      const res = await request(app).post(`/api/pipelines/${pipeline.body.id}/runs`).send({ components: [] });
      expect(res.status).toBe(400);
    });

    it("fetches full run detail via GET, 404 for an unknown run", async () => {
      const { app } = buildApp();
      const pipeline = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });
      const created = await request(app)
        .post(`/api/pipelines/${pipeline.body.id}/runs`)
        .send({ components: [{ type: "ApexClass", fullName: "MyClass" }] });

      const res = await request(app).get(`/api/pipeline-runs/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.componentList).toEqual([{ type: "ApexClass", fullName: "MyClass" }]);

      const missing = await request(app).get("/api/pipeline-runs/nonexistent-id");
      expect(missing.status).toBe(404);
    });

    it("deploys a step via POST", async () => {
      const { app, db } = buildApp();
      const source = createOrgConnection(db, { nickname: "Dev", orgType: "sandbox", instanceUrl: "https://x", refreshToken: "r", clientId: "c" });
      const target = createOrgConnection(db, { nickname: "QA", orgType: "sandbox", instanceUrl: "https://y", refreshToken: "r", clientId: "c" });
      const pipeline = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: [source.id, target.id] });
      const run = await request(app)
        .post(`/api/pipelines/${pipeline.body.id}/runs`)
        .send({ components: [{ type: "ApexClass", fullName: "MyClass" }] });

      vi.spyOn(engineRoutes, "resolveComponents").mockResolvedValue({
        kind: "org",
        components: [{ type: "ApexClass", fullName: "MyClass", lastModifiedDate: "2026-01-01" }],
      });
      vi.spyOn(deploy, "runDeployment").mockResolvedValue(undefined);

      const res = await request(app).post(`/api/pipeline-runs/${run.body.id}/steps/0/deploy`).send({ validateOnly: false });
      expect(res.status).toBe(202);
      expect(res.body.deploymentId).toBeTruthy();
    });

    it("reports a step-deploy failure as 400, not a 500", async () => {
      const { app } = buildApp();
      const pipeline = await request(app).post("/api/pipelines").send({ name: "Main", connectionIds: ["a", "b"] });
      const run = await request(app)
        .post(`/api/pipelines/${pipeline.body.id}/runs`)
        .send({ components: [{ type: "ApexClass", fullName: "MyClass" }] });

      const res = await request(app).post(`/api/pipeline-runs/${run.body.id}/steps/5/deploy`).send({ validateOnly: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeTruthy();
    });
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run src/pipelines/routes.test.ts`
Expected: FAIL — new routes don't exist, and `createPipelinesRouter` doesn't accept a second/third argument yet (TypeScript will also flag the extra args as an error until Step 4 lands).

- [ ] **Step 4: Implement in `server/src/pipelines/routes.ts`**

Add to the imports:

```typescript
import type { Config } from "../config.js";
import { createPipelineRun, listPipelineRuns, getPipelineRunDetail, deployPipelineStep } from "./pipelineRuns.js";
```

Change the function signature:

```typescript
export function createPipelinesRouter(db: Database.Database, config: Config, dataDir: string): Router {
```

Add these routes, right before the final `return router;`:

```typescript
  router.post("/api/pipelines/:id/runs", (req, res) => {
    const body = req.body as { title?: unknown; components?: unknown };
    if (
      !Array.isArray(body.components) ||
      body.components.some((c) => typeof c !== "object" || c === null || typeof (c as any).type !== "string" || typeof (c as any).fullName !== "string")
    ) {
      res.status(400).json({ error: "components is required and must be an array of { type, fullName }" });
      return;
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      res.status(400).json({ error: "title must be a string when provided" });
      return;
    }
    try {
      const run = createPipelineRun(db, {
        pipelineId: req.params.id,
        title: body.title as string | undefined,
        components: body.components as { type: string; fullName: string }[],
      });
      res.status(201).json(run);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get("/api/pipelines/:id/runs", (req, res) => {
    res.json(listPipelineRuns(db, req.params.id));
  });

  router.get("/api/pipeline-runs/:runId", (req, res) => {
    const detail = getPipelineRunDetail(db, req.params.runId);
    if (!detail) {
      res.status(404).json({ error: "pipeline run not found" });
      return;
    }
    res.json(detail);
  });

  router.post("/api/pipeline-runs/:runId/steps/:stepIndex/deploy", async (req, res) => {
    const stepIndex = Number(req.params.stepIndex);
    const body = req.body as { validateOnly?: unknown; runBy?: unknown };
    if (typeof body.validateOnly !== "boolean") {
      res.status(400).json({ error: "validateOnly is required and must be a boolean" });
      return;
    }
    if (body.runBy !== undefined && body.runBy !== null && typeof body.runBy !== "string") {
      res.status(400).json({ error: "runBy must be a string when provided" });
      return;
    }
    try {
      const result = await deployPipelineStep(db, config, dataDir, req.params.runId, stepIndex, {
        validateOnly: body.validateOnly,
        runBy: (body.runBy as string | null | undefined) ?? null,
      });
      res.status(202).json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
```

- [ ] **Step 5: Run pipelines route tests to verify they pass**

Run: `cd server && npx vitest run src/pipelines/routes.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Update `server/src/app.ts`'s call site**

Change:

```typescript
  app.use(createPipelinesRouter(db));
```

to:

```typescript
  app.use(createPipelinesRouter(db, config, dataDir));
```

(`config` and `dataDir` are already in scope in `createApp`'s parameter list.)

- [ ] **Step 7: Run the full server suite**

Run: `cd server && npx vitest run`
Expected: All tests pass (this includes `app.test.ts` — if Step 1 found a direct call there, confirm it was updated and is green).

- [ ] **Step 8: Commit**

```bash
git add server/src/pipelines/routes.ts server/src/pipelines/routes.test.ts server/src/app.ts
git commit -m "feat: add pipeline run HTTP endpoints"
```

---

## Task 9: Frontend `client.ts` — types and fetch functions

**Also fixes:** adding `trackComponentsIndependently` to the `Pipeline` interface makes it a required field on every existing `Pipeline`-shaped test fixture — TypeScript will fail to compile `web/src/pages/Home.test.tsx`'s two fixtures once this lands. Task 9's own steps below include patching them in the same commit, since leaving the build broken between tasks would make Task 9 untestable on its own.

**Files:**
- Modify: `web/src/api/client.ts`

**Interfaces:**
- Consumes: nothing (pure additions).
- Produces:
  ```typescript
  export interface Pipeline { id: string; name: string; connectionIds: string[]; status: "active" | "closed"; trackComponentsIndependently: boolean; }
  export interface PipelineRunComponent { type: string; fullName: string }
  export interface PipelineRunSummary { id: string; pipelineId: string; title: string | null; createdAt: string; componentCount: number; componentsAtFinalStage: number; }
  export interface PipelineStepDeploymentItem { metadataType: string; apiName: string; status: "pending" | "succeeded" | "failed" }
  export interface PipelineStepDeployment { id: string; stepIndex: number; status: string; validateOnly: boolean; startedAt: string; finishedAt: string | null; errorDetail: string | null; items: PipelineStepDeploymentItem[] }
  export interface ComponentPosition { type: string; fullName: string; stage: number; reachedAt: string | null }
  export interface PipelineRunDetail { id: string; pipelineId: string; title: string | null; createdAt: string; componentList: PipelineRunComponent[]; connectionIds: string[]; trackComponentsIndependently: boolean; deployments: PipelineStepDeployment[]; positions: ComponentPosition[] }

  export function fetchPipeline(id: string): Promise<Pipeline>
  export function createPipelineRun(pipelineId: string, input: { title?: string; components: PipelineRunComponent[] }): Promise<{ id: string }>
  export function fetchPipelineRuns(pipelineId: string): Promise<PipelineRunSummary[]>
  export function fetchPipelineRun(runId: string): Promise<PipelineRunDetail>
  export function deployPipelineStep(runId: string, stepIndex: number, input: { validateOnly: boolean; runBy?: string }): Promise<{ deploymentId: string; skipped: boolean }>
  ```
  `Pipeline` and `updatePipeline` already exist — extend, don't duplicate.

- [ ] **Step 1: Update the existing `Pipeline` interface and `updatePipeline`**

Change:

```typescript
export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
}
```

to:

```typescript
export interface Pipeline {
  id: string;
  name: string;
  connectionIds: string[];
  status: "active" | "closed";
  // Governs partial-hop-failure handling for every run of this pipeline — see pipelineRuns.ts on
  // the server for the exact semantics.
  trackComponentsIndependently: boolean;
}
```

Change:

```typescript
export function updatePipeline(id: string, input: { name: string; connectionIds: string[] }): Promise<Pipeline> {
```

to:

```typescript
export function updatePipeline(id: string, input: { name: string; connectionIds: string[]; trackComponentsIndependently?: boolean }): Promise<Pipeline> {
```

- [ ] **Step 2: Add `fetchPipeline`**

Right after `fetchPipelines`:

```typescript
export function fetchPipeline(id: string): Promise<Pipeline> {
  return fetch(`/api/pipelines/${id}`).then((r) => json(r));
}
```

- [ ] **Step 3: Add the pipeline-run types and functions**

At the end of the file:

```typescript
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
```

- [ ] **Step 4: Type-check to find every fixture this breaks**

Run: `cd web && npx tsc -b`
Expected: Errors in `web/src/pages/Home.test.tsx` — its two `Pipeline` fixtures are now missing `trackComponentsIndependently`.

- [ ] **Step 5: Patch the broken fixtures in `web/src/pages/Home.test.tsx`**

Change:

```typescript
  vi.mocked(client.fetchPipelines).mockResolvedValue([
    { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "active" },
    { id: "p2", name: "Old", connectionIds: ["1"], status: "closed" },
```

to:

```typescript
  vi.mocked(client.fetchPipelines).mockResolvedValue([
    { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "active", trackComponentsIndependently: true },
    { id: "p2", name: "Old", connectionIds: ["1"], status: "closed", trackComponentsIndependently: true },
```

- [ ] **Step 6: Type-check again**

Run: `cd web && npx tsc -b`
Expected: `web/src/pages/Pipelines.test.tsx` still shows the same kind of error — it has an identical `Pipeline` fixture gap, fixed by Task 10 (which rewrites that file entirely). That is the ONLY remaining error; if anything else is red, stop and investigate before continuing. Do not fix `Pipelines.test.tsx` in this task — Task 10 replaces it wholesale, and a partial fix here would just be overwritten.

- [ ] **Step 7: Run the affected test files**

Run: `cd web && npx vitest run src/pages/Home.test.tsx`
Expected: PASS (behavior is unchanged — this was a type-only fix).

- [ ] **Step 8: Commit**

```bash
git add web/src/api/client.ts web/src/pages/Home.test.tsx
git commit -m "feat: add pipeline-run API client functions"
```

---

## Task 10: Link pipelines to a detail page; route scaffolding

**Files:**
- Modify: `web/src/pages/Pipelines.tsx`
- Modify: `web/src/pages/Pipelines.test.tsx`
- Create: `web/src/pages/PipelineDetail.tsx` (minimal shell for now — Task 11 fills it in)
- Modify: `web/src/App.tsx`

**Interfaces:**
- Produces: `/pipelines/:id` route rendering `PipelineDetail`; each pipeline row on `Pipelines.tsx` links there.

**Also fixes:** `Pipelines.tsx` doesn't use `<Link>` today, so none of its existing tests wrap `render(<Pipelines />)` in a `MemoryRouter`. Adding a `Link` (Step 3) makes every one of those renders throw ("You should not use `<Link>` outside a `<Router>`") unless the whole test file is updated to render inside one — this task's Step 1 rewrites the file completely rather than patching around that.

- [ ] **Step 1: Rewrite `web/src/pages/Pipelines.test.tsx` completely**

Replace the entire file:

```typescript
// web/src/pages/Pipelines.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import * as client from "../api/client.js";
import { Pipelines } from "./Pipelines.js";

vi.mock("../api/client.js");

beforeEach(() => {
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchPipelines).mockResolvedValue([
    { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "active", trackComponentsIndependently: true },
  ]);
});

function renderPage() {
  return render(
    <MemoryRouter>
      <Pipelines />
    </MemoryRouter>
  );
}

describe("Pipelines page", () => {
  it("lists existing pipelines with resolved connection nicknames", async () => {
    renderPage();
    expect(await screen.findByText("Main")).toBeInTheDocument();
    expect(await screen.findByText(/Dev → QA/)).toBeInTheDocument();
  });

  it("links each pipeline's name to its detail page", async () => {
    renderPage();
    const link = await screen.findByRole("link", { name: "Main" });
    expect(link).toHaveAttribute("href", "/pipelines/p1");
  });

  it("creates a pipeline from selected connections in order", async () => {
    vi.mocked(client.createPipeline).mockResolvedValue({
      id: "p2",
      name: "Second",
      connectionIds: ["2", "1"],
      status: "active",
      trackComponentsIndependently: true,
    });
    renderPage();
    await screen.findByText("Main");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("QA"));
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    await waitFor(() =>
      expect(client.createPipeline).toHaveBeenCalledWith({ name: "Second", connectionIds: ["2", "1"] })
    );
  });

  it("shows an error message when creating a pipeline fails", async () => {
    vi.mocked(client.createPipeline).mockRejectedValue(new Error("pipeline name already exists"));
    renderPage();
    await screen.findByText("Main");

    fireEvent.change(screen.getByLabelText(/pipeline name/i), { target: { value: "Second" } });
    fireEvent.click(screen.getByLabelText("Dev"));
    fireEvent.click(screen.getByRole("button", { name: /create pipeline/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("pipeline name already exists");
  });

  it("shows a status badge and a Close toggle button for an active pipeline", async () => {
    renderPage();
    await screen.findByText("Main");
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close/i })).toBeInTheDocument();
  });

  it("closes a pipeline via the toggle button", async () => {
    vi.mocked(client.updatePipelineStatus).mockResolvedValue({
      id: "p1",
      name: "Main",
      connectionIds: ["1", "2"],
      status: "closed",
      trackComponentsIndependently: true,
    });
    renderPage();
    await screen.findByText("Main");

    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    await waitFor(() => expect(client.updatePipelineStatus).toHaveBeenCalledWith("p1", "closed"));
  });

  it("shows a Reopen button for a closed pipeline", async () => {
    vi.mocked(client.fetchPipelines).mockResolvedValue([
      { id: "p1", name: "Main", connectionIds: ["1", "2"], status: "closed", trackComponentsIndependently: true },
    ]);
    renderPage();
    await screen.findByText("Main");
    expect(screen.getByText("closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /reopen/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify the new one fails (and the rest still pass)**

Run: `cd web && npx vitest run src/pages/Pipelines.test.tsx`
Expected: 6 pass, 1 fails — "links each pipeline's name to its detail page" (pipeline names are plain text today, so no link exists yet).

- [ ] **Step 3: Update `Pipelines.tsx`**

Add `Link` to the `react-router-dom` import, then change the pipeline list item's name from plain text to a link. Find this line (it renders `<strong>{p.name}</strong>` inline with the connection chain):

```typescript
            <strong>{p.name}</strong>: {p.connectionIds.map(nicknameFor).join(" → ")}{" "}
```

Replace with:

```typescript
            <Link to={`/pipelines/${p.id}`}><strong>{p.name}</strong></Link>: {p.connectionIds.map(nicknameFor).join(" → ")}{" "}
```

- [ ] **Step 4: Create a minimal `PipelineDetail.tsx` shell**

```typescript
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { type Pipeline, fetchPipeline } from "../api/client.js";

export function PipelineDetail() {
  const { id } = useParams<{ id: string }>();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchPipeline(id)
      .then(setPipeline)
      .catch((err) => setLoadError((err as Error).message));
  }, [id]);

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!pipeline) return <p>Loading…</p>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/pipelines">Pipelines</Link>
        <span aria-hidden="true"> › </span>
        <span>{pipeline.name}</span>
      </nav>
      <h1>{pipeline.name}</h1>
    </div>
  );
}
```

- [ ] **Step 5: Wire the route in `App.tsx`**

Add the import:

```typescript
import { PipelineDetail } from "./pages/PipelineDetail.js";
```

Add the route, right after the `/pipelines` route:

```typescript
          <Route path="/pipelines/:id" element={<PipelineDetail />} />
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Pipelines.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run the full frontend suite**

Run: `cd web && npx vitest run`
Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/Pipelines.tsx web/src/pages/Pipelines.test.tsx web/src/pages/PipelineDetail.tsx web/src/App.tsx
git commit -m "feat: link pipelines to a new detail page"
```

---

## Task 11: `PipelineDetail.tsx` — Runs tab, New Run flow, Settings tab

**Files:**
- Modify: `web/src/pages/PipelineDetail.tsx`
- Create: `web/src/pages/PipelineDetail.test.tsx`

**Interfaces:**
- Consumes: `fetchPipeline`, `fetchConnections`, `fetchPipelineRuns`, `createPipelineRun`, `updatePipeline`, `fetchMetadataTypes`, `fetchDiff` from `client.ts`; `MetadataTypeSelector`, `DiffTable`/`diffItemKey` (existing components, reused as-is); `OBJECTS_AND_CHILD_COMPONENTS`, `expandTypeSelection` from `metadataTypeGroups.ts`; `nicknameFor`, `formatDate` from `deploymentDisplay.ts`.
- Produces: the finished `PipelineDetail` page. Clicking a run in the Runs tab navigates to `/pipelines/:id/runs/:runId` (that page is built in Task 12 — a `Link` to it is fine to add now even though the target route doesn't exist until then, same as any other in-progress multi-task frontend build in this codebase).

- [ ] **Step 1: Write the failing tests**

Create `web/src/pages/PipelineDetail.test.tsx`:

```typescript
// web/src/pages/PipelineDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { PipelineDetail } from "./PipelineDetail.js";

vi.mock("../api/client.js");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/pipelines/p1"]}>
      <Routes>
        <Route path="/pipelines/:id" element={<PipelineDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.fetchPipeline).mockResolvedValue({
    id: "p1",
    name: "Main Pipeline",
    connectionIds: ["c1", "c2"],
    status: "active",
    trackComponentsIndependently: true,
  });
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "c1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "c2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
  ]);
  vi.mocked(client.fetchPipelineRuns).mockResolvedValue([]);
  vi.mocked(client.fetchMetadataTypes).mockResolvedValue(["ApexClass"]);
});

describe("PipelineDetail page", () => {
  it("shows the pipeline's stage chips in order", async () => {
    renderPage();
    expect(await screen.findByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
  });

  it("shows an empty state and a New Run button in the Runs tab by default", async () => {
    renderPage();
    await screen.findByRole("heading", { name: /main pipeline/i });
    expect(screen.getByRole("button", { name: /new run/i })).toBeInTheDocument();
  });

  it("lists existing runs with their component-progress summary", async () => {
    vi.mocked(client.fetchPipelineRuns).mockResolvedValue([
      { id: "r1", pipelineId: "p1", title: "Batch 1", createdAt: "2026-01-01T00:00:00.000Z", componentCount: 3, componentsAtFinalStage: 1 },
    ]);
    renderPage();
    expect(await screen.findByText("Batch 1")).toBeInTheDocument();
    expect(screen.getByText(/1\s*\/\s*3/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /batch 1/i })).toHaveAttribute("href", "/pipelines/p1/runs/r1");
  });

  it("starts a new run: picks a type, loads the diff, selects a component, and submits", async () => {
    vi.mocked(client.fetchDiff).mockResolvedValue([{ type: "ApexClass", fullName: "MyClass", status: "added" }]);
    vi.mocked(client.createPipelineRun).mockResolvedValue({ id: "r2" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /new run/i }));
    fireEvent.focus(screen.getByRole("combobox", { name: /metadata types/i }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "ApexClass" }));
    fireEvent.click(screen.getByRole("button", { name: /load diff/i }));
    await screen.findByText("MyClass");

    fireEvent.click(screen.getByRole("checkbox", { name: "MyClass" }));
    fireEvent.click(screen.getByRole("button", { name: /^start run$/i }));

    await waitFor(() =>
      expect(client.createPipelineRun).toHaveBeenCalledWith("p1", {
        title: undefined,
        components: [{ type: "ApexClass", fullName: "MyClass" }],
      })
    );
  });

  it("switches to the Settings tab and toggles the tracking mode", async () => {
    vi.mocked(client.updatePipeline).mockResolvedValue({
      id: "p1",
      name: "Main Pipeline",
      connectionIds: ["c1", "c2"],
      status: "active",
      trackComponentsIndependently: false,
    });
    renderPage();

    fireEvent.click(await screen.findByRole("tab", { name: /settings/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /track components independently/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(client.updatePipeline).toHaveBeenCalledWith("p1", {
        name: "Main Pipeline",
        connectionIds: ["c1", "c2"],
        trackComponentsIndependently: false,
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/PipelineDetail.test.tsx`
Expected: FAIL — none of this UI exists yet in the Task 10 shell.

- [ ] **Step 3: Implement the full page**

Replace `web/src/pages/PipelineDetail.tsx` entirely:

```typescript
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type Pipeline,
  type ConnectionSummary,
  type PipelineRunSummary,
  type DiffItem,
  fetchPipeline,
  fetchConnections,
  fetchPipelineRuns,
  createPipelineRun,
  updatePipeline,
  fetchMetadataTypes,
  fetchDiff,
} from "../api/client.js";
import { DiffTable, diffItemKey } from "../components/DiffTable.js";
import { MetadataTypeSelector } from "../components/MetadataTypeSelector.js";
import { OBJECTS_AND_CHILD_COMPONENTS, expandTypeSelection } from "../metadataTypeGroups.js";
import { nicknameFor, formatDate } from "../deploymentDisplay.js";

type Tab = "runs" | "settings";

export function PipelineDetail() {
  const { id } = useParams<{ id: string }>();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [runs, setRuns] = useState<PipelineRunSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("runs");

  const [creatingRun, setCreatingRun] = useState(false);
  const [runTitle, setRunTitle] = useState("");
  const [availableTypes, setAvailableTypes] = useState<string[]>([]);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [diffItems, setDiffItems] = useState<DiffItem[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [runError, setRunError] = useState<string | null>(null);

  const [settingsName, setSettingsName] = useState("");
  const [trackIndependently, setTrackIndependently] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  function refresh() {
    if (!id) return;
    fetchPipeline(id)
      .then((p) => {
        setPipeline(p);
        setSettingsName(p.name);
        setTrackIndependently(p.trackComponentsIndependently);
      })
      .catch((err) => setLoadError((err as Error).message));
    fetchConnections().then(setConnections);
    fetchPipelineRuns(id).then(setRuns);
  }

  useEffect(refresh, [id]);

  function openNewRun() {
    setCreatingRun(true);
    setRunError(null);
    setDiffItems([]);
    setSelected(new Set());
    setSelectedTypes(new Set());
    setRunTitle("");
    if (pipeline) {
      fetchMetadataTypes(pipeline.connectionIds[0]).then(setAvailableTypes);
    }
  }

  async function handleLoadDiff() {
    if (!pipeline) return;
    setDiffLoading(true);
    setRunError(null);
    try {
      const items = await fetchDiff(pipeline.connectionIds[0], pipeline.connectionIds[1], expandTypeSelection(selectedTypes));
      setDiffItems(items);
      setSelected(new Set(items.filter((i) => i.status === "added" || i.status === "modified").map(diffItemKey)));
    } catch (err) {
      setRunError((err as Error).message);
    } finally {
      setDiffLoading(false);
    }
  }

  async function handleStartRun() {
    if (!id) return;
    setRunError(null);
    const components = diffItems.filter((item) => selected.has(diffItemKey(item))).map((item) => ({ type: item.type, fullName: item.fullName }));
    try {
      const { id: runId } = await createPipelineRun(id, { title: runTitle.trim() || undefined, components });
      setCreatingRun(false);
      refresh();
      // Nothing further to do here client-side — the Runs list link below takes the user to the
      // freshly created run once `refresh()` resolves. (Task 12 makes /pipelines/:id/runs/:runId
      // a real page; navigating there immediately is left as a follow-up polish, not required by
      // any test in this task.)
      void runId;
    } catch (err) {
      setRunError((err as Error).message);
    }
  }

  async function handleSaveSettings() {
    if (!id || !pipeline) return;
    setSettingsError(null);
    setSettingsSaved(false);
    try {
      const updated = await updatePipeline(id, {
        name: settingsName,
        connectionIds: pipeline.connectionIds,
        trackComponentsIndependently: trackIndependently,
      });
      setPipeline(updated);
      setSettingsSaved(true);
    } catch (err) {
      setSettingsError((err as Error).message);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!pipeline) return <p>Loading…</p>;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to="/pipelines">Pipelines</Link>
        <span aria-hidden="true"> › </span>
        <span>{pipeline.name}</span>
      </nav>

      <h1>{pipeline.name}</h1>
      <p className="pipeline-stages">
        {pipeline.connectionIds.map((connId, i) => (
          <span key={connId}>
            {i > 0 && <span aria-hidden="true"> → </span>}
            {nicknameFor(connections, connId)}
          </span>
        ))}
      </p>

      <div role="tablist">
        <button type="button" role="tab" aria-selected={tab === "runs"} onClick={() => setTab("runs")}>
          Runs
        </button>
        <button type="button" role="tab" aria-selected={tab === "settings"} onClick={() => setTab("settings")}>
          Settings
        </button>
      </div>

      {tab === "runs" && (
        <div>
          {runError && <p role="alert">{runError}</p>}
          {!creatingRun && (
            <>
              <button type="button" onClick={openNewRun} disabled={pipeline.connectionIds.length < 2}>
                New Run
              </button>
              <ul>
                {runs.map((r) => (
                  <li key={r.id}>
                    <Link to={`/pipelines/${pipeline.id}/runs/${r.id}`}>{r.title ?? formatDate(r.createdAt)}</Link>{" "}
                    <span>
                      {r.componentsAtFinalStage} / {r.componentCount} at final stage
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {creatingRun && (
            <div>
              <label>
                Run title (optional)
                <input value={runTitle} onChange={(e) => setRunTitle(e.target.value)} />
              </label>
              <h2>Component Types</h2>
              <MetadataTypeSelector
                types={[OBJECTS_AND_CHILD_COMPONENTS, ...availableTypes]}
                selected={selectedTypes}
                onToggle={(type) =>
                  setSelectedTypes((prev) => {
                    const next = new Set(prev);
                    if (next.has(type)) next.delete(type);
                    else next.add(type);
                    return next;
                  })
                }
                onSelectAll={() => setSelectedTypes(new Set([OBJECTS_AND_CHILD_COMPONENTS, ...availableTypes]))}
                onSelectNone={() => setSelectedTypes(new Set())}
              />
              <button onClick={handleLoadDiff} disabled={selectedTypes.size === 0 || diffLoading}>
                {diffLoading ? "Loading…" : "Load Diff"}
              </button>
              {diffItems.length > 0 && <DiffTable items={diffItems} selected={selected} onToggle={(key) => setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })} />}
              <div className="form-actions">
                <button type="button" onClick={handleStartRun} disabled={selected.size === 0}>
                  Start run
                </button>
                <button type="button" onClick={() => setCreatingRun(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "settings" && (
        <div>
          {settingsError && <p role="alert">{settingsError}</p>}
          {settingsSaved && <p role="status">Saved.</p>}
          <label>
            Name
            <input
              value={settingsName}
              onChange={(e) => {
                setSettingsName(e.target.value);
                setSettingsSaved(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={trackIndependently}
              onChange={(e) => {
                setTrackIndependently(e.target.checked);
                setSettingsSaved(false);
              }}
            />
            Track components independently
          </label>
          <div className="form-actions">
            <button type="button" onClick={handleSaveSettings}>
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/PipelineDetail.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 5: Run the full frontend suite**

Run: `cd web && npx vitest run`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/PipelineDetail.tsx web/src/pages/PipelineDetail.test.tsx
git commit -m "feat: add pipeline Runs/Settings tabs and a New Run flow"
```

---

## Task 12: `PipelineRunDetail.tsx` — stepper and per-component grid

**Files:**
- Create: `web/src/pages/PipelineRunDetail.tsx`
- Create: `web/src/pages/PipelineRunDetail.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `fetchPipelineRun`, `fetchConnections`, `deployPipelineStep` from `client.ts`; `StatusBadge` (existing component); `nicknameFor`, `formatDate` from `deploymentDisplay.ts`; `getDisplayName` from `displayName.ts`.
- Produces: `/pipelines/:pipelineId/runs/:runId` route.

- [ ] **Step 1: Write the failing tests**

Create `web/src/pages/PipelineRunDetail.test.tsx`:

```typescript
// web/src/pages/PipelineRunDetail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as client from "../api/client.js";
import { PipelineRunDetail } from "./PipelineRunDetail.js";

vi.mock("../api/client.js");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/pipelines/p1/runs/r1"]}>
      <Routes>
        <Route path="/pipelines/:pipelineId/runs/:runId" element={<PipelineRunDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

function baseRun(overrides: Partial<client.PipelineRunDetail> = {}): client.PipelineRunDetail {
  return {
    id: "r1",
    pipelineId: "p1",
    title: "Batch 1",
    createdAt: "2026-01-01T00:00:00.000Z",
    componentList: [{ type: "ApexClass", fullName: "MyClass" }],
    connectionIds: ["c1", "c2", "c3"],
    trackComponentsIndependently: true,
    deployments: [],
    positions: [{ type: "ApexClass", fullName: "MyClass", stage: 0, reachedAt: null }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.fetchConnections).mockResolvedValue([
    { id: "c1", type: "org", nickname: "Dev", createdAt: "", lastUsedAt: null },
    { id: "c2", type: "org", nickname: "QA", createdAt: "", lastUsedAt: null },
    { id: "c3", type: "org", nickname: "Prod", createdAt: "", lastUsedAt: null },
  ]);
});

describe("PipelineRunDetail page", () => {
  it("shows every stage's nickname across the top", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    expect(await screen.findByText("Dev")).toBeInTheDocument();
    expect(screen.getByText("QA")).toBeInTheDocument();
    expect(screen.getByText("Prod")).toBeInTheDocument();
  });

  it("shows the component grid with a blank cell for a component still at stage 0", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("");
  });

  it("shows a checkmark and timestamp for a component that has advanced past a stage", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        positions: [{ type: "ApexClass", fullName: "MyClass", stage: 1, reachedAt: "2026-01-02T00:00:00.000Z" }],
      })
    );
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("✓");
  });

  it("shows a failure marker for a component that failed the step it's currently stuck at", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "failed",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [{ metadataType: "ApexClass", apiName: "MyClass", status: "failed" }],
          },
        ],
      })
    );
    renderPage();
    const cell = await screen.findByTestId("cell-ApexClass::MyClass-0");
    expect(cell).toHaveTextContent("✗");
  });

  it("enables Validate/Deploy on a hop only while at least one component is eligible for it", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    renderPage();
    await screen.findByText("Dev");

    const hop0Deploy = screen.getAllByRole("button", { name: /^deploy$/i })[0];
    const hop1Deploy = screen.getAllByRole("button", { name: /^deploy$/i })[1];
    expect(hop0Deploy).not.toBeDisabled();
    expect(hop1Deploy).toBeDisabled();
  });

  it("deploys a hop and refetches the run", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });
    renderPage();
    await screen.findByText("Dev");

    fireEvent.click(screen.getAllByRole("button", { name: /^deploy$/i })[0]);

    await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: false, runBy: undefined }));
    await waitFor(() => expect(client.fetchPipelineRun).toHaveBeenCalledTimes(2));
  });

  it("validates a hop without advancing anyone", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(baseRun());
    vi.mocked(client.deployPipelineStep).mockResolvedValue({ deploymentId: "d1", skipped: false });
    renderPage();
    await screen.findByText("Dev");

    fireEvent.click(screen.getAllByRole("button", { name: /^validate$/i })[0]);

    await waitFor(() => expect(client.deployPipelineStep).toHaveBeenCalledWith("r1", 0, { validateOnly: true, runBy: undefined }));
  });

  it("shows a hop's most recent status and timestamp once it has a deployment", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "succeeded",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [],
          },
        ],
        positions: [{ type: "ApexClass", fullName: "MyClass", stage: 1, reachedAt: "2026-01-01T00:05:00.000Z" }],
      })
    );
    renderPage();
    expect(await screen.findByText(/succeeded/i)).toBeInTheDocument();
  });

  it("links a hop with a deployment to that deployment's own detail page", async () => {
    vi.mocked(client.fetchPipelineRun).mockResolvedValue(
      baseRun({
        deployments: [
          {
            id: "d1",
            stepIndex: 0,
            status: "failed",
            validateOnly: false,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:05:00.000Z",
            errorDetail: null,
            items: [{ metadataType: "ApexClass", apiName: "MyClass", status: "failed" }],
          },
        ],
      })
    );
    renderPage();
    const link = await screen.findByRole("link", { name: /view deployment/i });
    expect(link).toHaveAttribute("href", "/deployments/d1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/PipelineRunDetail.test.tsx`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement `web/src/pages/PipelineRunDetail.tsx`**

```typescript
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  type ConnectionSummary,
  type PipelineRunDetail as PipelineRunDetailType,
  type PipelineStepDeployment,
  fetchConnections,
  fetchPipelineRun,
  deployPipelineStep,
} from "../api/client.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { nicknameFor, formatDate } from "../deploymentDisplay.js";
import { getDisplayName } from "../displayName.js";

function componentKey(c: { type: string; fullName: string }): string {
  return `${c.type}::${c.fullName}`;
}

// The deployment (if any) most recently tagged to this hop — later start time wins among however
// many attempts/retries have been tagged to the same step.
function latestDeploymentForStep(deployments: PipelineStepDeployment[], stepIndex: number): PipelineStepDeployment | undefined {
  return deployments
    .filter((d) => d.stepIndex === stepIndex)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
}

type CellState = "done" | "failed" | "pending";

function cellState(
  position: { stage: number },
  columnIndex: number,
  component: { type: string; fullName: string },
  deployments: PipelineStepDeployment[]
): CellState {
  if (position.stage > columnIndex) return "done";
  if (position.stage !== columnIndex) return "pending";
  const attempt = latestDeploymentForStep(deployments, columnIndex);
  if (!attempt) return "pending";
  const item = attempt.items.find((i) => `${i.metadataType}::${i.apiName}` === componentKey(component));
  return item?.status === "failed" ? "failed" : "pending";
}

export function PipelineRunDetail() {
  const { runId } = useParams<{ pipelineId: string; runId: string }>();
  const [run, setRun] = useState<PipelineRunDetailType | null>(null);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyStep, setBusyStep] = useState<number | null>(null);

  function refresh() {
    if (!runId) return;
    fetchPipelineRun(runId)
      .then(setRun)
      .catch((err) => setLoadError((err as Error).message));
  }

  useEffect(() => {
    fetchConnections().then(setConnections);
  }, []);
  useEffect(refresh, [runId]);

  async function handleStep(stepIndex: number, validateOnly: boolean) {
    if (!runId) return;
    setActionError(null);
    setBusyStep(stepIndex);
    try {
      await deployPipelineStep(runId, stepIndex, { validateOnly, runBy: getDisplayName() || undefined });
      refresh();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyStep(null);
    }
  }

  if (loadError) return <p role="alert">{loadError}</p>;
  if (!run) return <p>Loading…</p>;

  const hopCount = run.connectionIds.length - 1;

  return (
    <div>
      <nav aria-label="Breadcrumb" className="breadcrumb">
        <Link to={`/pipelines/${run.pipelineId}`}>Pipeline</Link>
        <span aria-hidden="true"> › </span>
        <span>{run.title ?? formatDate(run.createdAt)}</span>
      </nav>

      <h1>{run.title ?? formatDate(run.createdAt)}</h1>
      {actionError && <p role="alert">{actionError}</p>}

      <ol className="pipeline-stepper">
        {run.connectionIds.map((connId, stageIndex) => (
          <li key={connId}>
            <div className="stage-name">{nicknameFor(connections, connId)}</div>
            {stageIndex < hopCount &&
              (() => {
                const eligible = run.positions.filter((p) => p.stage === stageIndex).length;
                const deployment = latestDeploymentForStep(run.deployments, stageIndex);
                return (
                  <div className="hop">
                    {deployment ? (
                      <>
                        <StatusBadge status={deployment.status} />
                        {deployment.finishedAt && <span className="hop-timestamp">{formatDate(deployment.finishedAt)}</span>}
                        <Link to={`/deployments/${deployment.id}`}>View deployment</Link>
                      </>
                    ) : (
                      <span className="hop-timestamp">Not started</span>
                    )}
                    <button type="button" onClick={() => handleStep(stageIndex, true)} disabled={eligible === 0 || busyStep === stageIndex}>
                      Validate
                    </button>
                    <button type="button" onClick={() => handleStep(stageIndex, false)} disabled={eligible === 0 || busyStep === stageIndex}>
                      Deploy
                    </button>
                  </div>
                );
              })()}
          </li>
        ))}
      </ol>

      <table>
        <thead>
          <tr>
            <th>Component</th>
            {run.connectionIds.map((connId) => (
              <th key={connId}>{nicknameFor(connections, connId)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.componentList.map((component) => {
            const position = run.positions.find((p) => componentKey(p) === componentKey(component))!;
            return (
              <tr key={componentKey(component)}>
                <td>
                  {component.type} {component.fullName}
                </td>
                {run.connectionIds.map((_, columnIndex) => {
                  const state = cellState(position, columnIndex, component, run.deployments);
                  return (
                    <td key={columnIndex} data-testid={`cell-${componentKey(component)}-${columnIndex}`}>
                      {state === "done" && <span title={position.reachedAt ?? undefined}>✓</span>}
                      {state === "failed" && <span>✗</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Wire the route in `App.tsx`**

Add the import:

```typescript
import { PipelineRunDetail } from "./pages/PipelineRunDetail.js";
```

Add the route, right after `/pipelines/:id`:

```typescript
          <Route path="/pipelines/:pipelineId/runs/:runId" element={<PipelineRunDetail />} />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/PipelineRunDetail.test.tsx`
Expected: PASS (all tests).

- [ ] **Step 6: Run the full frontend suite**

Run: `cd web && npx vitest run`
Expected: All tests pass.

- [ ] **Step 7: Type-check and build both packages**

Run: `cd server && npm run build && cd ../web && npm run build`
Expected: Both build cleanly.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/PipelineRunDetail.tsx web/src/pages/PipelineRunDetail.test.tsx web/src/App.tsx
git commit -m "feat: add pipeline run detail page with stepper and component grid"
```

---

## Task 13: Styling pass

**Files:**
- Modify: `web/src/index.css`

**Interfaces:**
- Consumes: `.pipeline-stepper`, `.stage-name`, `.hop`, `.hop-timestamp`, `.pipeline-stages` class names introduced (unstyled) in Tasks 11-12.

- [ ] **Step 1: Add styles**

Add to `web/src/index.css`, near the other page-specific rules (e.g. next to `.breadcrumb`):

```css
.pipeline-stages {
  color: var(--text-muted);
  margin-top: 4px;
}

.pipeline-stepper {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  list-style: none;
  padding: 0;
  margin: 24px 0;
  flex-wrap: wrap;
}

.pipeline-stepper > li {
  display: flex;
  align-items: center;
  gap: 16px;
}

.pipeline-stepper .stage-name {
  font-weight: 600;
  white-space: nowrap;
}

.pipeline-stepper .hop {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.pipeline-stepper .hop-timestamp {
  font-size: 0.85em;
  color: var(--text-muted);
  white-space: nowrap;
}
```

- [ ] **Step 2: Build to confirm no CSS errors**

Run: `cd web && npm run build`
Expected: Builds cleanly.

- [ ] **Step 3: Commit**

```bash
git add web/src/index.css
git commit -m "style: add pipeline stepper and grid styling"
```

---

## Task 14: Manual verification in the browser

**Files:** none (verification only).

- [ ] **Step 1: Rebuild and restart the live server**

```bash
cd server && npm run build
cd ../web && npm run build
```

Restart the running SFCowboy server process the same way prior sessions in this project have (find the `node.exe` PID serving it, terminate it, then re-run the Startup-folder launcher at `C:\Users\Phillip\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\SFCowboy-Server.vbs`) so the rebuilt `server/dist` and `web/dist` are actually being served.

- [ ] **Step 2: Back up the live database before this session ever ran real migrations against it**

```bash
cp server/sfcowboy.db "server/sfcowboy.db.bak-$(date +%Y%m%d-%H%M%S)"
```

(This file must never be `git add`ed — it isn't covered by the `*.db` gitignore pattern since its name doesn't end in `.db`, so add files individually rather than `git add -A` for the rest of this task, exactly as established earlier in this project.)

- [ ] **Step 3: Create a real pipeline with two connected orgs already in this environment**

In the browser, go to Pipelines → New Pipeline, name it, and select two of the already-authorized org connections in order (source first, target second).

- [ ] **Step 4: Start a run and validate a hop**

Open the new pipeline's detail page, click New Run, pick a metadata type both orgs share (e.g. `ApexClass`), load the diff, select one or two low-risk components, and start the run. On the run's detail page, click **Validate** (not Deploy) on the first hop — this exercises the real diff/validate path against Salesforce without ever touching the target, matching this project's standing rule of never triggering a real deploy during verification unless explicitly confirmed.

- [ ] **Step 5: Confirm the grid updates correctly**

After the validate call resolves, confirm: the hop shows a status badge and timestamp; the per-component grid still shows the component at stage 0 (a validate must never advance anyone — check this explicitly, since it's the one behavior a UI bug could easily get backwards).

- [ ] **Step 6: If comfortable doing a real deploy, click Deploy on the first hop**

Only do this if the components picked in Step 4 are genuinely safe to deploy in the connected orgs. Confirm: the hop's status turns `succeeded`, the grid's first-hop cell for each successfully-deployed component shows a checkmark with a timestamp, and the second hop's Validate/Deploy buttons become enabled (since those components are now eligible for it).

- [ ] **Step 7: Report findings back**

Summarize what worked and anything that looked wrong, without making further code changes yet — this task is verification only, so any bug found here should be triaged (root-caused via the systematic-debugging skill) before being patched, not patched reflexively.
