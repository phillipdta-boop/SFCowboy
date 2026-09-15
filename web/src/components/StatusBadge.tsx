import { formatStatusLabel } from "../deploymentDisplay.js";
import { useCowboyMode } from "../useCowboyMode.js";
import { CowboyGlyph, type CowboyGlyphName } from "./CowboyGlyph.js";

// Was a map of OS emoji. Those rendered differently on every platform, never took the badge's own
// colour, and couldn't move -- so "deploying" looked exactly as inert as "cancelled". The marks
// below are picked for legibility at 13px rather than for literalness: a spur rowel reads as work
// turning over, where a galloping horse would collapse into a smudge at that size.
const COWBOY_STATUS_GLYPH: Record<string, CowboyGlyphName> = {
  succeeded: "horseshoe",
  failed: "skull",
  cancelled: "lasso",
  rolled_back: "uturn",
  pending: "cactus",
  validating: "rowel",
  deploying: "rowel",
};

export const STATUS_COLOR_CLASS: Record<string, string> = {
  succeeded: "status-label-success",
  failed: "status-label-danger",
  cancelled: "status-label-muted",
  rolled_back: "status-label-muted",
  pending: "status-label-muted",
  validating: "status-label-warning",
  deploying: "status-label-warning",
};

const iconCommon = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function StatusIcon({ status }: { status: string }) {
  if (status === "succeeded") {
    return (
      <svg {...iconCommon}>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12.5 2.5 2.5L16 9.5" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg {...iconCommon}>
        <circle cx="12" cy="12" r="9" />
        <path d="m9 9 6 6" />
        <path d="m15 9-6 6" />
      </svg>
    );
  }
  if (status === "cancelled") {
    return (
      <svg {...iconCommon}>
        <circle cx="12" cy="12" r="9" />
        <path d="M7 7l10 10" />
      </svg>
    );
  }
  if (status === "rolled_back") {
    return (
      <svg {...iconCommon}>
        <path d="M4 10a8 8 0 1 1 2.5 5.8" />
        <path d="M4 4v6h6" />
      </svg>
    );
  }
  if (status === "validating" || status === "deploying") {
    return (
      <svg {...iconCommon}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
    );
  }
  // pending, and any other/unknown status.
  return (
    <svg {...iconCommon}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const cowboyMode = useCowboyMode();
  return (
    <span className={`status-label ${STATUS_COLOR_CLASS[status] ?? "status-label-muted"}`}>
      {cowboyMode && COWBOY_STATUS_GLYPH[status] ? (
        <CowboyGlyph name={COWBOY_STATUS_GLYPH[status]} />
      ) : (
        <StatusIcon status={status} />
      )}
      {formatStatusLabel(status)}
    </span>
  );
}
