import { useId } from "react";
import { useLoadingMessages } from "./useLoadingMessages.js";

// Cowboy Mode's loading state, rebuilt as a western one-sheet rather than a cartoon.
//
// The previous version tried for a fully shaded illustration -- gradient-filled horse, rider, sun,
// cacti -- and the gap between that ambition and hand-written bezier curves was where it read as
// amateur: legs floated free of a blob-shaped body, the rider sat in front of the horse instead of
// on it, and the cacti were rectangles. This version removes the shading entirely. The figure is
// one flat fill silhouetted against the sky, which is the composition western posters use anyway,
// and a silhouette has no interior anatomy left to get subtly wrong.
//
// The figure is drawn to horse proportions rather than by eye: body length about equal to height at
// the withers, legs a little over half the total height, head roughly a third of body length. Those
// ratios are the whole difference between reading as a horse and reading as a dog.
//
// Everything is painted from --cowboy-* custom properties (see index.css) so the scene follows the
// app's light/dark theme instead of being a fixed sunset pasted over both.

const COWBOY_LOADING_MESSAGES = [
  "Riding out to Salesforce…",
  "Rounding up components…",
  "Checking the deployment…",
  "Wrangling metadata…",
  "Checking your badge…",
  "Almost there…",
] as const;

// Each dune band is two identical 320-unit tiles laid end to end, so translating the whole path
// left by exactly one tile width returns it to its starting appearance -- that's what makes the
// parallax loop seamlessly instead of snapping. Every segment is 80 units wide and begins and ends
// on the baseline, which is what keeps the two tiles continuous across the seam.
function duneTiles(baseline: number, peaks: readonly number[]): string {
  let d = `M0 ${baseline}`;
  for (let tile = 0; tile < 2; tile++) {
    for (let i = 0; i < 4; i++) {
      const x0 = tile * 320 + i * 80;
      d += ` Q${x0 + 40} ${peaks[i]} ${x0 + 80} ${baseline}`;
    }
  }
  return `${d} L640 180 L0 180 Z`;
}

// Drawn once, hanging straight down from its own (0,0) joint, then placed per leg by the wrapping
// <g> and swung from that joint by CSS. Sharing one path keeps all four legs identical in weight.
const LEG =
  "M0 0 C-3 0 -4.4 2.2 -4.4 5 L-5.6 26 C-6 30.5 -4.2 33.6 -1.4 33.6 L2.8 33.6 C4.4 33.6 5.2 31.6 4.7 28.8 L2.8 5 C2.6 1.8 1.8 0 0 0 Z";

export function CowboyLoader({ label = "Loading…" }: { label?: string }) {
  const [message, messageIndex] = useLoadingMessages(COWBOY_LOADING_MESSAGES);
  // A literal id would collide if two loaders were ever on screen at once: SVG resolves a
  // duplicate id to whichever came first, so the second scene would silently paint itself with the
  // first one's gradient -- including its theme.
  // useId output contains colons, which are legal in an HTML id but break a url(#...)
  // reference, so they are stripped here.
  const skyId = `cowboy-sky-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <div className="cowboy-loader" role="status" aria-label={label}>
      <div className="cowboy-loader-scene">
        <svg viewBox="0 0 320 180" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <defs>
            <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--cowboy-sky-top)" />
              <stop offset="55%" stopColor="var(--cowboy-sky-mid)" />
              <stop offset="100%" stopColor="var(--cowboy-sky-low)" />
            </linearGradient>
          </defs>

          <rect x="0" y="0" width="320" height="180" fill={`url(#${skyId})`} />

          {/* The signature: the sun doubles as the progress indicator. A dashed ring sweeps its
              circumference, dips behind the dunes and re-emerges, so the one element the eye is
              drawn to is also the one saying work is still happening. */}
          <circle
            className="cowboy-loader-arc"
            cx="216"
            cy="104"
            r="45"
            fill="none"
            stroke="var(--cowboy-sun)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray="60 223"
            opacity="0.75"
          />
          <circle cx="216" cy="104" r="33" fill="var(--cowboy-sun)" />

          <g className="cowboy-loader-dunes-far">
            <path d={duneTiles(124, [108, 115, 102, 114])} fill="var(--cowboy-ground)" opacity="0.38" />
          </g>
          <g className="cowboy-loader-dunes-mid">
            <path d={duneTiles(138, [126, 132, 122, 130])} fill="var(--cowboy-ground)" opacity="0.66" />
          </g>

          {/* Horse and rider, one flat fill. Hooves land at local y=60, which the transform puts on
              the near ridge; the far-side legs sit at reduced opacity because in a single-colour
              silhouette overlapping limbs would otherwise be invisible. */}
          <g transform="translate(72 99) scale(0.85)">
            <g className="cowboy-loader-sway">
              <g fill="var(--cowboy-ground)" opacity="0.72">
                <g transform="translate(13 27)">
                  <path className="cowboy-loader-leg cowboy-loader-leg-1" d={LEG} />
                </g>
                <g transform="translate(49 27)">
                  <path className="cowboy-loader-leg cowboy-loader-leg-3" d={LEG} />
                </g>
              </g>

              <g fill="var(--cowboy-ground)">
                {/* Tail, streaming back off the croup. */}
                <path d="M7 11 C-1 7 -11 11 -19 20 C-12 16 -5 16 -1 19 C-7 24 -12 31 -15 39 C-6 30 2 22 7 19 Z" />
                {/* Body, traced croup -> back -> withers -> neck crest -> poll -> muzzle -> jaw ->
                    throat -> chest -> belly -> flank. The dip between croup and withers and the
                    wedge of the head are what stop it reading as a barrel with a stump. */}
                <path d="M6 10 C14 6 22 8 30 11 C36 13 42 12 46 9 C50 2 58 -7 68 -14 C72 -16 78 -16 81 -12 C84 -8 87 -3 86 1 C85 4 82 5 79 4 C74 3 70 2 67 -1 C62 -3 59 0 57 5 C55 11 54 16 54 21 C54 25 55 28 54 31 C47 34 37 36 27 35 C19 34 12 31 8 27 C3 22 1 15 6 10 Z" />
                {/* Rider: torso pitched forward over the withers, near leg bent into the stirrup,
                    rein arm reaching down to the bit, roping arm raised up and back, head, hat. */}
                <path d="M24 12 C23 4 27 -4 34 -10 C37 -12.5 41 -11 42 -7 C43 -3 40 1 36 5 C33 9 32 12 32 16 C29 17 25 16 24 12 Z" />
                <path d="M26 10 C30 14 35 18 37 22 C39 25 38 29 35 30.5 L31 31 C31 27.5 30.5 24 28 20.5 C26 17.5 24 15 23 13 Z" />
                <path d="M39 -6 C44 -3 50 2 55 7 C57 9 55.6 12 53 11 C48 7 43 3 38 0 Z" />
                <path d="M32 -5 C31 -12 29 -19 26.5 -26 C25.5 -29 30 -30.5 31 -27.5 C33.5 -20 35.5 -12 36.5 -5 Z" />
                <circle cx="43" cy="-16" r="5" />
                <path d="M31 -20.5 C31 -23 36 -22 43 -22 C50 -22 55 -23 55 -20.5 C55 -18 49.5 -16.5 43 -16.5 C36.5 -16.5 31 -18 31 -20.5 Z" />
                <path d="M37 -21.6 C36.2 -27.5 38.4 -32 43 -32 C47.6 -32 49.8 -27.5 49 -21.6 C47 -20.8 39 -20.8 37 -21.6 Z" />
              </g>

              <g fill="var(--cowboy-ground)">
                <g transform="translate(18 28)">
                  <path className="cowboy-loader-leg cowboy-loader-leg-2" d={LEG} />
                </g>
                <g transform="translate(54 28)">
                  <path className="cowboy-loader-leg cowboy-loader-leg-4" d={LEG} />
                </g>
              </g>

              {/* The rope from the hand is static and the loop above it precesses -- a lariat is
                  swung from a fixed grip, so spinning the loop a full turn would read as a hoop
                  tumbling on a stick instead. */}
              <path
                d="M28 -27 C27 -30 26.6 -32 26.4 -34"
                fill="none"
                stroke="var(--cowboy-ground)"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <g className="cowboy-loader-lasso">
                <ellipse
                  cx="26"
                  cy="-40"
                  rx="15"
                  ry="5.5"
                  fill="none"
                  stroke="var(--cowboy-ground)"
                  strokeWidth="2.2"
                />
              </g>
            </g>
          </g>

          {/* Dust kicked off the hooves, drifting back and dissipating. */}
          <g fill="var(--cowboy-ground)" opacity="0.5">
            <circle className="cowboy-loader-dust cowboy-loader-dust-1" cx="112" cy="144" r="3" />
            <circle className="cowboy-loader-dust cowboy-loader-dust-2" cx="96" cy="146" r="2.2" />
            <circle className="cowboy-loader-dust cowboy-loader-dust-3" cx="124" cy="145" r="2.6" />
          </g>

          <g className="cowboy-loader-ridge">
            <path d={duneTiles(148, [145, 146.4, 144.6, 146])} fill="var(--cowboy-ground)" />
          </g>
        </svg>
      </div>

      {/* key remounts the line on each change so it fades in, matching StandardLoader's behaviour. */}
      <p className="cowboy-loader-caption" key={messageIndex} aria-hidden="true">
        {message}
      </p>
    </div>
  );
}
