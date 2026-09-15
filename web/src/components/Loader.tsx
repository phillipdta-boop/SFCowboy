import { useCowboyMode } from "../useCowboyMode.js";
import { CowboyLoader } from "./CowboyLoader.js";
import { useLoadingMessages } from "./useLoadingMessages.js";

// Purely cosmetic -- there's no real per-step progress to report during a page-level fetch, so
// these just cycle to make the wait feel less like a frozen screen. Worded generically enough to
// fit any deployment/pipeline page this loader appears on.
const LOADING_MESSAGES = [
  "Connecting to Salesforce…",
  "Resolving components…",
  "Checking deployment status…",
  "Syncing metadata…",
  "Verifying permissions…",
  "Almost there…",
];

function StandardLoader({ label }: { label: string }) {
  const [message, messageIndex] = useLoadingMessages(LOADING_MESSAGES);

  return (
    <div className="standard-loader" role="status" aria-label={label}>
      <div className="standard-loader-spinner" aria-hidden="true" />
      <div className="standard-loader-bar" aria-hidden="true">
        <div className="standard-loader-bar-fill" />
      </div>
      {/* key forces a remount on each message change, retriggering the fade-in animation */}
      <p className="standard-loader-subtext" key={messageIndex} aria-hidden="true">
        {message}
      </p>
    </div>
  );
}

// Swaps the plain spinner for the galloping Cowboy Mode loader -- used everywhere a
// deployment/pipeline page shows a page-level loading state, so the one toggle covers all of them.
export function Loader({ label = "Loading…" }: { label?: string }) {
  const cowboyMode = useCowboyMode();
  if (cowboyMode) return <CowboyLoader label={label} />;
  return <StandardLoader label={label} />;
}
