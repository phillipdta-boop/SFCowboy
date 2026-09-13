// Shared between UserMenu.tsx's dropdown summary and the full Usage.tsx page, so the two always
// render a status breakdown the same way.
export const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  validating: "Validating",
  deploying: "Deploying",
  succeeded: "Succeeded",
  failed: "Failed",
  rolled_back: "Rolled back",
  cancelled: "Cancelled",
};

function totalOf(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

export function UsageSection({ label, counts }: { label: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).filter(([, count]) => count > 0);
  return (
    <div className="usage-section">
      <div className="usage-section-label">
        <span>{label}</span>
        <span>{totalOf(counts)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="usage-section-empty">No deployments</p>
      ) : (
        <ul className="usage-section-list">
          {rows.map(([status, count]) => (
            <li key={status}>
              <span>{STATUS_LABELS[status] ?? status}</span>
              <span>{count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
