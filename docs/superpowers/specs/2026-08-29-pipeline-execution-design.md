# Pipeline execution design

**Date:** 2026-08-29
**Status:** Approved by user, ready for implementation planning

## Problem

Pipelines (`pipelines` table + `Pipelines.tsx`) today are purely descriptive: a
name and an ordered list of connections (e.g. Dev → QA → UAT → Production).
Nothing in the app reads that order to drive an actual deployment — the New
Deployment flow picks source/target directly from the connections list and
never consults a pipeline. There is no way to promote a set of components
through a pipeline's stages, and no record of which stage a component has
reached or when.

This spec wires pipelines into the existing deployment engine: a **pipeline
run** promotes a fixed set of components through a pipeline's stages one hop
at a time, with each hop manually validated or deployed by the user, and a UI
showing each component's current stage and per-stage timestamp.

## Goals

- Starting a pipeline run: pick a pipeline, pick components once (diffed
  against the first hop), get a run you can work through.
- Each hop (stage *N* → stage *N+1*) is validated/deployed manually — no
  auto-advance.
- A hop only accepts components that are actually eligible for it (see
  "Eligibility" below) — this is what makes hops sequential.
- A UI shows, per component, which stage it has reached and when.
- Reuse the existing deploy engine, diff engine, and `DeploymentDetailPage`
  wherever possible. A pipeline hop's deploy/validate IS a normal deployment
  record, just tagged with which run and which hop it belongs to.

## Non-goals

- Editing a run's component set after it's created (out of scope — start a
  new run instead).
- Automatic/scheduled promotion. Every hop is a manual click.
- Migrating existing ad-hoc deployments into pipeline runs retroactively.
- Multi-user permissions/approval gates on a hop (this app has no auth model
  beyond the existing self-reported `run_by` display name).

## Data model

### `pipelines` (existing table, one new column)

```sql
ALTER TABLE pipelines ADD COLUMN track_components_independently INTEGER NOT NULL DEFAULT 1;
```

- `1` (default): **track independently** — a hop's succeeded components
  advance; failed ones stay behind and can be retried at that hop without
  blocking the others.
- `0`: **whole batch blocked** — a hop only counts as complete when a single
  deploy attempt succeeds for every component still pending at that hop. A
  partial success holds the *entire* batch back, including the components
  that individually succeeded — they get redeployed together on retry.

Editable via the pipeline's Settings tab. Applies to every run of that
pipeline (not a per-run choice, per user decision).

### `pipeline_runs` (new table)

```sql
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  title TEXT,
  component_list TEXT NOT NULL, -- JSON: [{ type, fullName }]
  created_at TEXT NOT NULL
);
```

- `component_list` is the fixed set of components chosen when the run was
  created (type + fullName only — no `action`, since each hop computes its
  own add/modify/delete via a fresh diff against that hop's source/target).
- No `status` column: a run's status (in progress / complete) is always
  derived from its steps' deployments at read time, never stored redundantly.
- No separate "current stage" column per run or per component — see
  "Deriving component position" below.

### `deployments` (existing table, two new nullable columns)

```sql
ALTER TABLE deployments ADD COLUMN pipeline_run_id TEXT REFERENCES pipeline_runs(id);
ALTER TABLE deployments ADD COLUMN pipeline_step_index INTEGER;
```

- Both NULL for every deployment created outside a pipeline run (the
  overwhelming majority, and all existing rows).
- When a hop is validated/deployed, the engine creates a **normal**
  deployment (same `createDraftDeployment` + `attachComponentsAndQueue` +
  `runDeployment` path already used by `NewDeployment`/`DeploymentEditor`),
  with `pipeline_run_id` and `pipeline_step_index` set. `pipeline_step_index`
  is 0-based: step 0 is the hop between `pipeline.connectionIds[0]` and
  `[1]`, step 1 is between `[1]` and `[2]`, etc.
- Retrying a hop creates *another* deployment tagged with the same
  `(pipeline_run_id, pipeline_step_index)` — there is no cap on how many
  deployments a single step can accumulate over time. The most recent
  successful (or most recent, if none succeeded) one is what the UI shows by
  default, with older attempts still reachable through the run's history.

No new table for per-component tracking — see below.

## Deriving component position (no new table)

For a given `(pipeline_run_id, component)`, its current stage index `S` is
computed as:

```
S = 1 + max({ step_index : exists a deployment tagged (run_id, step_index)
                            with status = 'succeeded'
                            AND ( that deployment's deployment_items has
                                  this component with status = 'succeeded'
                                  OR this component was not part of that
                                  deployment's component_list at all —
                                  meaning the hop's diff found it already
                                  unchanged there, so it passed through
                                  without needing to move ) }
              ∪ { -1 })
```

(`S = 0` when the set is empty, i.e. the component hasn't advanced past the
run's starting stage yet.)

The timestamp shown for reaching stage `S` is that deployment's
`finished_at`.

For a `track_components_independently = 0` pipeline, this formula still
applies mechanically, but the orchestration layer (below) guarantees that a
step's deployment either includes *and succeeds* every still-pending
component or the step doesn't count as advancing anyone — so in practice
every component in that run always reports the same `S`.

## Eligibility (what makes hops sequential)

A component is **eligible for step `N`** iff its current derived stage `S`
(computed against steps `0..N-1`) equals `N`. Concretely: eligible for step 0
means it just hasn't been touched yet (every component starts here); eligible
for step `N > 0` means it succeeded step `N-1`.

When the user opens step `N`'s Validate/Deploy UI, the component list offered
is `run.component_list` filtered to those currently eligible for step `N`. If
that set is empty, the step shows "nothing ready yet" instead of a diff/pick
UI — there is no separate "unlock" flag to maintain; eligibility is computed
the same way position is.

Validating a step never changes eligibility (it never touches the target, so
nothing derived from `deployment_items` succeeding changes). Only a real
Deploy that succeeds moves components past a hop.

For `track_components_independently = 0` pipelines, the orchestration layer
additionally refuses to start step `N+1` at all while step `N` has any
pending (not-yet-succeeded-as-a-whole) components — i.e. the "all still
pending" condition described above.

## API surface

New/changed server endpoints (all under the existing `pipelines` and
`engine` route modules):

- `PATCH /api/pipelines/:id` — extend existing update to also accept
  `trackComponentsIndependently: boolean`.
- `GET /api/pipelines/:id` — new; single-pipeline fetch (today only a list
  endpoint exists), needed by the new pipeline detail page.
- `POST /api/pipelines/:id/runs` — create a pipeline run. Body:
  `{ title?, components: {type, fullName}[] }`.
- `GET /api/pipelines/:id/runs` — list runs for a pipeline (id, title,
  created_at, and enough to show an overall status in the Runs tab).
- `GET /api/pipeline-runs/:runId` — full run detail: the pipeline's stage
  list, `component_list`, and for each step index, every deployment tagged
  to it (id, status, started_at, finished_at, error summary, **and its
  `deployment_items`** — metadata_type/api_name/status/error_message for
  each component that deployment actually touched). The items are what let
  the client derive per-component position itself, without a bespoke
  "position" endpoint. (Deriving on the client from data already needed for
  the grid keeps the server endpoint a thin passthrough — no duplicate
  derivation logic in two languages.)
- `POST /api/pipeline-runs/:runId/steps/:stepIndex/deploy` — body matches
  today's `DeployRunOptions` (minus `components`, since eligibility computes
  that server-side) plus `validateOnly`. Internally: compute eligible
  components for this step, diff them against this hop's source/target,
  create+attach+run a tagged deployment the same way
  `POST /api/deployments/:id/run` does today, return `{ deploymentId }`.

No new endpoint is needed for "retry" — it's the same
`.../steps/:stepIndex/deploy` call again.

## UI

### Pipelines list page (existing, `Pipelines.tsx`)

Unchanged creation form. Each pipeline row becomes a link to its new detail
page instead of being purely inline.

### Pipeline detail page (new, `/pipelines/:id`)

- Stage chips across the top (connection nicknames in order).
- **Runs** tab (default): list of past runs, each showing title/created_at
  and an overall status derived from its steps (e.g. "3/4 components at
  Production", "in progress at QA→UAT"). "New Run" button opens the
  component picker (reusing the existing diff-loading picker component from
  `DeploymentEditor`/`NewDeployment`, scoped to hop 0) and, on submit, calls
  `POST /api/pipelines/:id/runs` then navigates to the run detail page.
- **Settings** tab: rename, reorder/edit connections (reuses whatever the
  current creation form's connection-picker UI is), and the
  track-independently vs whole-batch-blocked toggle.

### Pipeline run detail page (new, `/pipelines/:id/runs/:runId`)

- A stepper across the top: one node per stage, each hop between two nodes
  showing its status (not started / in progress / succeeded / partial /
  failed) and the `finished_at` timestamp of its most recent deployment.
- Each hop has its own Validate/Deploy buttons, active only while at least
  one component is eligible for it; clicking either calls
  `.../steps/:stepIndex/deploy`.
- A per-component table below the stepper: rows = components (type +
  fullName), columns = stages. Each cell shows a checkmark + timestamp once
  that component reached that stage, blank if not yet, or an error marker
  (with the summarized failure reason, reusing the existing
  `summarizeDeployFailure`-style approach) if it failed at that specific hop.
- Clicking a hop's status, or a failed cell, links to the real
  `DeploymentDetailPage` for the underlying tagged deployment — no new
  detail view needed there; it already handles everything (collapsed status
  panel, error summary, component picker for a re-run) unchanged.

## Edge cases

- A pipeline needs ≥ 2 connections before "New Run" is offered (nothing to
  promote through with only one stage).
- A connection referenced by a pipeline that gets deleted later falls back
  exactly the way the rest of the app already does today (nickname lookup
  falls back to showing the raw connection id) — no new handling required.
- A run is "complete" once every component's derived stage equals the
  pipeline's last stage index — read off the per-component grid, not stored.
- Deleting a pipeline while it has runs: out of scope for this pass: the
  existing `DELETE /api/pipelines/:id` behavior is left as-is; if it
  currently allows deleting a pipeline with runs, that leaves orphaned runs
  reachable only by direct URL. Revisit if this becomes a real problem —
  not blocking for the initial feature.

## Testing approach

Following this project's existing TDD discipline:

- Server: unit tests for the position/eligibility derivation function (pure,
  given a run's component list + a set of tagged deployments with item
  statuses, returns per-component stage + timestamp) — this is the one piece
  of genuinely new logic and deserves the most direct test coverage.
- Server: route tests for the five new/changed endpoints, including the
  independent-vs-blocked behavior difference on a partially-failing step.
- Frontend: component tests for the stepper's enabled/disabled state per
  eligibility, and the per-component grid's cell rendering (done / pending /
  failed).
- Manual verification against the live orgs already connected in this
  environment, same as every other feature built this session — never a
  real deploy during automated tests, real ones only via explicit,
  deliberate manual clicks when verifying.
