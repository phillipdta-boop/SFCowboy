import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient.js";
import { fetchMyUsage, type UsageBreakdown } from "./api/client.js";

const STATUS_LABELS: Record<string, string> = {
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

function UsageSection({ label, counts }: { label: string; counts: Record<string, number> }) {
  const rows = Object.entries(counts).filter(([, count]) => count > 0);
  return (
    <div className="user-menu-usage-section">
      <div className="user-menu-usage-label">
        <span>{label}</span>
        <span>{totalOf(counts)}</span>
      </div>
      {rows.length === 0 ? (
        <p className="user-menu-usage-empty">No deployments</p>
      ) : (
        <ul className="user-menu-usage-list">
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

export function UserMenu({ name, email }: { name: string; email: string }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<UsageBreakdown | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Closes on any click outside the menu -- a standard dropdown affordance react-router's own
  // components don't provide out of the box.
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  // Fetched lazily on first open rather than on mount -- most sessions never open this menu, and
  // the nav renders on every authenticated page.
  useEffect(() => {
    if (!open || usage || usageError) return;
    fetchMyUsage()
      .then(setUsage)
      .catch((err) => setUsageError(err instanceof Error ? err.message : "Failed to load usage"));
  }, [open, usage, usageError]);

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="user-menu" ref={containerRef}>
      <button type="button" className="user-menu-trigger" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="true">
        {name}
      </button>
      {open && (
        <div className="user-menu-panel" role="menu">
          <div className="user-menu-header">
            <div className="user-menu-name">{name}</div>
            <div className="user-menu-email">{email}</div>
          </div>
          <div className="user-menu-usage">
            <div className="user-menu-usage-title">Deployment usage</div>
            {usageError && <div className="error-banner">{usageError}</div>}
            {!usageError && !usage && <p className="user-menu-usage-empty">Loading…</p>}
            {usage && (
              <>
                <UsageSection label="This month" counts={usage.thisMonth} />
                <UsageSection label="All time" counts={usage.allTime} />
              </>
            )}
          </div>
          <button type="button" className="user-menu-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
