import { useCowboyMode } from "../useCowboyMode.js";
import { CowboyLoader } from "./CowboyLoader.js";

// Swaps the plain spinner for the galloping Cowboy Mode loader -- used everywhere a
// deployment/pipeline page shows a page-level loading state, so the one toggle covers all of them.
export function Loader({ label = "Loading…" }: { label?: string }) {
  const cowboyMode = useCowboyMode();
  if (cowboyMode) return <CowboyLoader label={label} />;
  return <div className="spinner" role="status" aria-label={label} />;
}
