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
      .filter((d) => d.stepIndex === stepIndex && !d.validateOnly)
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
