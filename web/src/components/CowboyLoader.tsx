// A simple line-art gallop loop for Cowboy Mode's loading state -- matches the app's existing
// thin-stroke icon style (see NavIcons.tsx/StatusBadge.tsx) rather than a photorealistic asset,
// which is a better fit for a small inline loading indicator anyway.
export function CowboyLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="cowboy-loader" role="status" aria-label={label}>
      <svg viewBox="0 0 140 90" width="140" height="90" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <g className="cowboy-loader-lasso">
          <circle cx="88" cy="18" r="14" />
        </g>
        <g className="cowboy-loader-rider">
          <line x1="82" y1="30" x2="88" y2="18" />
          <circle cx="66" cy="24" r="7" />
          <path d="M66 31 L60 46" />
          <path d="M60 46 L52 40" />
        </g>
        <g className="cowboy-loader-body">
          <path d="M20 50 Q35 30 65 34 Q85 36 92 50 Q80 56 60 55 Q35 55 20 50 Z" />
          <path d="M18 48 L8 42" />
          <path d="M8 42 L14 40" />
        </g>
        <g className="cowboy-loader-legs-back">
          <path d="M32 52 L28 70" />
          <path d="M48 55 L45 72" />
        </g>
        <g className="cowboy-loader-legs-front">
          <path d="M70 53 L74 71" />
          <path d="M86 51 L91 69" />
        </g>
        <line className="cowboy-loader-ground" x1="4" y1="74" x2="136" y2="74" strokeDasharray="4 5" opacity="0.35" />
      </svg>
    </div>
  );
}
