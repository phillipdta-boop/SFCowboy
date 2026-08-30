import { Fragment } from "react";
import { type ConnectionSummary } from "../api/client.js";
import { nicknameFor, environmentBadge } from "../deploymentDisplay.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export interface PipelineEnvironmentSummaryProps {
  connections: ConnectionSummary[];
  connectionIds: string[];
}

/** The pipeline-stage equivalent of EnvironmentSummary — same bordered card, icon, and
 * Production/Sandbox/Git badge per environment, but for however many stages a pipeline has
 * (2 or 20) rather than a fixed source/target pair. .env-card wraps onto further rows instead
 * of overflowing once a pipeline has more stages than fit on one line. */
export function PipelineEnvironmentSummary({ connections, connectionIds }: PipelineEnvironmentSummaryProps) {
  return (
    <div className="env-card">
      {connectionIds.map((connId, i) => {
        const connection = connections.find((c) => c.id === connId);
        const badge = environmentBadge(connections, connId);
        return (
          <Fragment key={connId}>
            {i > 0 && (
              <span className="env-card-arrow" aria-hidden="true">
                →
              </span>
            )}
            <div className="env-card-item">
              <span className="env-card-caption">
                <ConnectionTypeIcon type={connection?.type ?? "org"} /> Stage {i + 1}
              </span>
              <span className="env-card-name">{nicknameFor(connections, connId)}</span>
              <span className={`badge ${badge.className}`}>{badge.label}</span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
