// The visual vocabulary for Cowboy Mode. These replace the raw emoji the mode used to borrow from
// the OS (🤠 💀 🌵 🐎) -- those rendered differently on every platform, never matched the weight of
// the app's own icon set, and couldn't be animated or take a badge's color. Every mark here is
// drawn on the same 24x24 grid, inherits currentColor, and defaults to em sizing so it sits on the
// text baseline wherever it's dropped in.
//
// Chosen for legibility at 14px rather than for literalness: a spur rowel reads as "turning, work
// in progress" at that size where a galloping horse would collapse into a blob, and a longhorn
// skull is both more western and more distinct from the app's own failure icon than a plain skull.

export type CowboyGlyphName =
  | "hat"
  | "horseshoe"
  | "skull"
  | "cactus"
  | "rowel"
  | "lasso"
  | "uturn";

const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const GLYPHS: Record<CowboyGlyphName, JSX.Element> = {
  // The brand mark: headings, the toggle, Quick Deploy.
  hat: (
    <g fill="currentColor">
      <path d="M3.2 14.4c0-1.9 2.4-1.1 8.8-1.1s8.8-.8 8.8 1.1c0 2.1-3.9 3.7-8.8 3.7s-8.8-1.6-8.8-3.7Z" />
      <path d="M7.4 13.9c-.7-4.7.6-9.1 4.6-9.1s5.3 4.4 4.6 9.1c-1.6.5-7.6.5-9.2 0Z" />
    </g>
  ),
  horseshoe: (
    <g {...STROKE} strokeWidth="2.9">
      <path d="M7.4 19.6C4.6 17.4 3.2 14.2 3.6 11 4.2 6.4 7.7 3.2 12 3.2s7.8 3.2 8.4 7.8c.4 3.2-1 6.4-3.8 8.6" />
    </g>
  ),
  // A longhorn skull, not a generic one -- the horns are what make it readable at 14px.
  skull: (
    <g fill="currentColor">
      <path d="M12 8.2c2.3 0 3.8 1.4 3.8 3.4 0 1.7-.6 2.8-1.1 3.6-.4.7-.6 1.4-.6 2.3 0 1.3-.9 2.1-2.1 2.1s-2.1-.8-2.1-2.1c0-.9-.2-1.6-.6-2.3-.5-.8-1.1-1.9-1.1-3.6 0-2 1.5-3.4 3.8-3.4Z" />
      <path
        {...STROKE}
        strokeWidth="2.4"
        d="M8.6 10C6.6 7.6 4 6.4 1.9 7.2M15.4 10c2-2.4 4.6-3.6 6.7-2.8"
      />
    </g>
  ),
  cactus: (
    <g {...STROKE}>
      <path strokeWidth="3.6" d="M12 20.6V5.4" />
      <path strokeWidth="2.6" d="M12 13.2H8.9V9.6" />
      <path strokeWidth="2.6" d="M12 15.4h3.2v-4.6" />
    </g>
  ),
  // A spur rowel. Spinning it is the natural read for work in progress.
  rowel: (
    // One path with evenodd so the hub is a real hole -- a filled dot would have to know the
    // badge background behind it, which differs per status.
    <path
      fill="currentColor"
      fillRule="evenodd"
      d="m12 2 2.1 3.6 4-1-1 4L20.7 11 17.1 13l1 4-4-1L12 19.6 9.9 16l-4 1 1-4L3.3 11l3.6-2-1-4 4 1L12 2Zm0 7.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6Z"
    />
  ),
  lasso: (
    <g {...STROKE} strokeWidth="2">
      <ellipse cx="12" cy="9.6" rx="7.4" ry="4.4" />
      <path d="M12 14v6.4" />
    </g>
  ),
  uturn: (
    <g {...STROKE} strokeWidth="2.2">
      <path d="M4.6 19.4v-6.6a5.2 5.2 0 0 1 5.2-5.2h9.6" />
      <path d="m15.6 3.6 4 3.9-4 3.9" />
    </g>
  ),
};

export function CowboyGlyph({
  name,
  size = "1em",
  className,
}: {
  name: CowboyGlyphName;
  size?: number | string;
  className?: string;
}) {
  return (
    <svg
      className={className ? `cowboy-glyph ${className}` : "cowboy-glyph"}
      data-cowboy-glyph={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
