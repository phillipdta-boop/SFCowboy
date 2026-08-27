// Simple generic line icons for the top nav — no external icon library, no third-party logos.
const common = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function HomeIcon() {
  return (
    <svg {...common}>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5.5 10v9a1 1 0 0 0 1 1H10v-6h4v6h3.5a1 1 0 0 0 1-1v-9" />
    </svg>
  );
}

export function ConnectionsIcon() {
  return (
    <svg {...common}>
      <path d="M9 15 15 9" />
      <path d="M10.5 6.5 13 4a3.5 3.5 0 0 1 5 5l-2.5 2.5" />
      <path d="M13.5 17.5 11 20a3.5 3.5 0 0 1-5-5l2.5-2.5" />
    </svg>
  );
}

export function PipelinesIcon() {
  return (
    <svg {...common}>
      <circle cx="5" cy="6" r="2.5" />
      <circle cx="19" cy="6" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M7.2 7.2 10 15" />
      <path d="M16.8 7.2 14 15" />
    </svg>
  );
}

export function DeploymentsIcon() {
  return (
    <svg {...common}>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

export function HistoryIcon() {
  return (
    <svg {...common}>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l3 2" />
      <path d="M9 2h6" />
    </svg>
  );
}
