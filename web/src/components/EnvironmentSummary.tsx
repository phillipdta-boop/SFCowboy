import { type ConnectionSummary } from "../api/client.js";
import { nicknameFor, environmentBadge } from "../deploymentDisplay.js";
import { ConnectionTypeIcon } from "../ConnectionIcons.js";

export interface EnvironmentSummaryProps {
  connections: ConnectionSummary[];
  sourceId: string;
  targetId: string;
  // The branch actually in use for a git side of this deployment — its override if one was set
  // at draft creation, otherwise that connection's own default. Ignored for an org connection.
  sourceBranch?: string | null;
  targetBranch?: string | null;
}

/** A bordered card naming this deployment's source and target environments — each connection's
 * own icon (Salesforce/GitHub) alongside its nickname, Production/Sandbox/Git badge, and (for a
 * git connection) which branch is in use, so it's unambiguous at a glance where a deployment
 * reads from and where it writes to. */
export function EnvironmentSummary({ connections, sourceId, targetId, sourceBranch, targetBranch }: EnvironmentSummaryProps) {
  const source = connections.find((c) => c.id === sourceId);
  const target = connections.find((c) => c.id === targetId);
  const sourceBadge = environmentBadge(connections, sourceId);
  const targetBadge = environmentBadge(connections, targetId);

  return (
    <div className="env-card">
      <div className="env-card-item">
        <span className="env-card-caption">
          <ConnectionTypeIcon type={source?.type ?? "org"} /> Source
        </span>
        <span className="env-card-name">{nicknameFor(connections, sourceId)}</span>
        <span className={`badge ${sourceBadge.className}`}>{sourceBadge.label}</span>
        {source?.type === "git" && (sourceBranch ?? source.defaultBranch) && (
          <span className="env-card-branch">Branch: {sourceBranch ?? source.defaultBranch}</span>
        )}
      </div>
      <span className="env-card-arrow" aria-hidden="true">
        →
      </span>
      <div className="env-card-item">
        <span className="env-card-caption">
          <ConnectionTypeIcon type={target?.type ?? "org"} /> Target
        </span>
        <span className="env-card-name">{nicknameFor(connections, targetId)}</span>
        <span className={`badge ${targetBadge.className}`}>{targetBadge.label}</span>
        {target?.type === "git" && (targetBranch ?? target.defaultBranch) && (
          <span className="env-card-branch">Branch: {targetBranch ?? target.defaultBranch}</span>
        )}
      </div>
    </div>
  );
}
