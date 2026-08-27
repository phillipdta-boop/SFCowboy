import type { ConnectionSummary } from "./api/client.js";

export function nicknameFor(connections: ConnectionSummary[], id: string): string {
  return connections.find((c) => c.id === id)?.nickname ?? id;
}

// Flags what kind of environment a connection is, so a row makes it obvious at a glance whether
// a deployment is headed into a sandbox or — worth a second look — Production.
export function environmentBadge(connections: ConnectionSummary[], id: string): { label: string; className: string } {
  const conn = connections.find((c) => c.id === id);
  if (!conn) return { label: "Unknown", className: "badge-unchanged" };
  if (conn.type === "git") return { label: "Git", className: "badge-unchanged" };
  if (conn.orgType === "production") return { label: "Production", className: "badge-removed" };
  if (conn.orgType === "sandbox") return { label: "Sandbox", className: "badge-new" };
  return { label: "Org", className: "badge-unchanged" };
}

export function formatDate(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleString();
}

// "rolled_back" -> "Rolled back"; "succeeded" -> "Succeeded".
export function formatStatusLabel(status: string): string {
  const words = status.split("_").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
