import { useEffect, useState } from "react";
import { fetchMyUsage, type UsageBreakdown as UsageBreakdownData } from "../api/client.js";
import { UsageSection } from "../components/UsageBreakdown.js";

export function Usage() {
  const [usage, setUsage] = useState<UsageBreakdownData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyUsage()
      .then(setUsage)
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <div className="usage-page">
      <h1>Usage</h1>
      <p>Deployments you've run, by status.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !usage && <div className="spinner" role="status" aria-label="Loading…" />}
      {usage && (
        <>
          <UsageSection label="This month" counts={usage.thisMonth} />
          <UsageSection label="All time" counts={usage.allTime} />
        </>
      )}
    </div>
  );
}
