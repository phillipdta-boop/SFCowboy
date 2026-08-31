// Shared substring-match rule for every per-column/list filter box in the app (Deployments,
// History, Pipeline Run Detail, Connections, Pipelines) — kept in one place so "search" behaves
// identically everywhere: case-insensitive, blank filter always matches, leading/trailing
// whitespace in what the user typed is ignored.
export function matchesFilter(value: string, filterText: string): boolean {
  const trimmed = filterText.trim();
  if (!trimmed) return true;
  return value.toLowerCase().includes(trimmed.toLowerCase());
}
