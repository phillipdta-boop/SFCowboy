import { Fragment } from "react";
import { type ConnectionSummary } from "../api/client.js";
import { nicknameFor, environmentBadge } from "../deploymentDisplay.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export interface PipelineEnvironmentSummaryProps {
  connections: ConnectionSummary[];
  connectionIds: string[];
}

/** The pipeline-stage equivalent of EnvironmentSummary — each environment's own icon and
 * Production/Sandbox/Git badge, but for however many stages a pipeline has (2 or 20) rather than
 * a fixed source/target pair, and stacked vertically (same visual language as the run page's own
 * stepper) so a long pipeline grows down the page instead of wrapping awkwardly across rows. Its
 * connectors carry no status color of their own -- unlike the run page's stepper, this is the
 * pipeline's static definition, not a specific run's live progress. */
export function PipelineEnvironmentSummary({ connections, connectionIds }: PipelineEnvironmentSummaryProps) {
  return (
    <ol className="pipeline-vstepper pipeline-overview-vstepper">
      {connectionIds.map((connId, i) => {
        const connection = connections.find((c) => c.id === connId);
        const badge = environmentBadge(connections, connId);
        return (
          <Fragment key={connId}>
            {i > 0 && (
              <li className="vstepper-connector status-label-muted">
                <span className="vstepper-connector-arrow" aria-hidden="true" />
              </li>
            )}
            <li className="vstepper-node">
              <span className="vstepper-node-icon">
                <ConnectionTypeIcon type={connection?.type ?? "org"} />
              </span>
              <span className="vstepper-node-stage">Stage {i + 1}</span>
              <span className="vstepper-node-name">{nicknameFor(connections, connId)}</span>
              <span className={`badge ${badge.className}`}>{badge.label}</span>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}
