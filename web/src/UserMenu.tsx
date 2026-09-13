import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "./supabaseClient.js";
import { fetchMyUsage, type UsageBreakdown } from "./api/client.js";
import { UsageSection } from "./components/UsageBreakdown.js";

export function UserMenu({ name, email, isAdmin }: { name: string; email: string; isAdmin: boolean }) {
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
            {!usageError && !usage && <p className="usage-section-empty">Loading…</p>}
            {usage && (
              <>
                <UsageSection label="This month" counts={usage.thisMonth} />
                <UsageSection label="All time" counts={usage.allTime} />
              </>
            )}
            <Link to="/usage" className="user-menu-nav-link" onClick={() => setOpen(false)}>
              View full usage
            </Link>
          </div>
          {isAdmin && (
            <Link to="/team" className="user-menu-nav-link" onClick={() => setOpen(false)}>
              Team
            </Link>
          )}
          <button type="button" className="user-menu-logout" onClick={handleLogout}>
            Log out
          </button>
        </div>
      )}
    </div>
  );
}
