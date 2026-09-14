// A filled, shaded gallop loop for Cowboy Mode's loading state, set against a desert sunset scene
// (sky, sun dipping behind distant dunes, sand, saguaro cacti) rather than a flat background --
// solid silhouettes with gradient shading read as far more dimensional than a thin-stroke line
// figure, without needing a real illustrated asset. Sized to fill its container edge to edge (see
// .cowboy-loader/svg in index.css) rather than sitting as a small fixed-size box within it.
export function CowboyLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="cowboy-loader" role="status" aria-label={label}>
      <svg viewBox="0 0 220 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
        <defs>
          <linearGradient id="cowboy-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b2352" />
            <stop offset="35%" stopColor="#a1436b" />
            <stop offset="65%" stopColor="#e8703f" />
            <stop offset="100%" stopColor="#ffd08a" />
          </linearGradient>
          <radialGradient id="cowboy-sun-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#fff6d8" stopOpacity="1" />
            <stop offset="45%" stopColor="#ffdd8a" stopOpacity="0.75" />
            <stop offset="100%" stopColor="#ffb85c" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="cowboy-sand" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e2a765" />
            <stop offset="100%" stopColor="#a8703f" />
          </linearGradient>
          <linearGradient id="cowboy-horse-body" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b07d47" />
            <stop offset="100%" stopColor="#7a4d27" />
          </linearGradient>
          <linearGradient id="cowboy-horse-leg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8a5a30" />
            <stop offset="100%" stopColor="#5e3a1c" />
          </linearGradient>
          <linearGradient id="cowboy-shirt" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#4f7cac" />
            <stop offset="100%" stopColor="#33547a" />
          </linearGradient>
          <linearGradient id="cowboy-hat" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6b4423" />
            <stop offset="100%" stopColor="#4a2e17" />
          </linearGradient>
          <radialGradient id="cowboy-shadow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#000000" stopOpacity="0.4" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
          {/* Diagonal candy-cane stripes rather than a flat color -- this is what actually reads
              as twisted rope fiber instead of a plain ring. */}
          <pattern id="cowboy-rope" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="2" height="2" fill="#dcae72" />
            <rect width="1" height="2" fill="#8a5a35" />
          </pattern>
        </defs>

        {/* Desert sunset backdrop */}
        <rect x="0" y="0" width="220" height="70" fill="url(#cowboy-sky)" />
        <circle cx="165" cy="46" r="24" fill="url(#cowboy-sun-glow)" />
        <circle cx="165" cy="46" r="12" fill="#fff3d6" />
        <path fill="#6b4058" opacity="0.85" d="M0 66 Q30 56 60 62 Q95 68 130 60 Q160 53 190 62 Q205 66 220 63 L220 72 L0 72 Z" />
        <path fill="#5c3a2e" d="M0 70 Q35 62 70 68 Q105 74 140 66 Q175 60 220 68 L220 74 L0 74 Z" />
        <rect x="0" y="72" width="220" height="28" fill="url(#cowboy-sand)" />
        <g fill="#2a2015">
          <rect x="13" y="50" width="7" height="42" rx="3.5" />
          <rect x="6" y="61" width="9" height="6" rx="3" />
          <rect x="5" y="50" width="6" height="15" rx="3" />
          <rect x="18" y="67" width="8" height="5" rx="2.5" />
          <rect x="21" y="57" width="5" height="14" rx="2.5" />
        </g>
        <g fill="#241c12">
          <rect x="199" y="58" width="6" height="34" rx="3" />
          <rect x="204" y="68" width="8" height="5" rx="2.5" />
          <rect x="207" y="58" width="5" height="14" rx="2.5" />
        </g>

        {/* Leaner horse -- a straighter topline and a clear gap below the rider, rather than a
            round-bodied silhouette the rider's own shape sinks into. */}
        <ellipse className="cowboy-loader-shadow" cx="115" cy="88" rx="42" ry="5" fill="url(#cowboy-shadow)" />

        <g className="cowboy-loader-legs-back" fill="url(#cowboy-horse-leg)">
          <path d="M78 63 Q75 63 74 66 L71 84 Q70 87 73 87 L78 87 Q81 87 81 84 L82 65 Q82 63 78 63 Z" />
          <path d="M92 65 Q89 65 88 68 L86 84 Q85 87 88 87 L93 87 Q96 87 96 84 L97 67 Q97 65 92 65 Z" />
        </g>

        <g className="cowboy-loader-body">
          <path fill="#4a2e17" d="M72 55 Q63 58 61 66 Q60 71 64 76 Q63 68 68 62 Q70 58 72 55 Z" />
          <path
            fill="url(#cowboy-horse-body)"
            d="M74 65
               C69 65 66 61 68 56
               C71 50 82 47 95 47.5
               C105 48 112 50 116 55
               C121 50 128 42 135 37
               C137 34 140 33.5 141 35.5
               C139.5 38 138.5 39 139.5 40.5
               C145 42.5 150.5 46 153 49.5
               C154.5 51.5 152.5 53 150 53
               C147 53 144.5 52 141.5 53.5
               C138.5 55 134.5 56 129.5 57.5
               C124.5 59 121.5 60.5 117.5 62
               L74 62.5 Z"
          />
        </g>

        <g className="cowboy-loader-legs-front" fill="url(#cowboy-horse-leg)">
          <path d="M104 64 Q101 64 100 67 L98 82 Q97 85 100 85 L105 85 Q108 85 108 82 L109 66 Q109 64 104 64 Z" />
          <path d="M116 62 Q113 62 112 65 L111 81 Q110 84 113 84 L118 84 Q121 84 121 81 L122 64 Q122 62 116 62 Z" />
        </g>

        <g className="cowboy-loader-rider">
          {/* Trailing leg */}
          <path fill="#33547a" d="M98 42 Q103 45.5 105 51 Q102 53.5 99 52.5 Q97 47 98 42 Z" />
          {/* Torso */}
          <path fill="url(#cowboy-shirt)" d="M87 22 Q84 30 87 40 Q92.5 43.5 98 40 Q100 30 96 22 Q91.5 19 87 22 Z" />
          {/* Arm raised to the lasso */}
          <path fill="#4f7cac" d="M96 25.5 Q103.5 21 108.5 14.5 Q110.5 16.5 108.5 19.5 Q105 25 99 30 Q96 28 96 25.5 Z" />
          {/* Head */}
          <circle cx="86" cy="17.5" r="5.2" fill="#dba25a" />
          {/* Hat */}
          <ellipse cx="85" cy="12.8" rx="8.8" ry="2.7" fill="url(#cowboy-hat)" />
          <path fill="url(#cowboy-hat)" d="M79.8 8 Q85 3 90.7 8 Q89.7 11.7 85 11.7 Q80.8 11.7 79.8 8 Z" />
        </g>

        {/* A wide, tilted loop trailing from a honda knot in the rider's hand -- the tail/knot stay
            put (a real lasso's coils stay in the thrower's hand) while only the loop itself spins,
            anchored at the knot via transform-origin, using the diagonal candy-cane rope texture
            throughout. */}
        <path d="M108.5 14.5 Q104 12 106 9" fill="none" stroke="url(#cowboy-rope)" strokeWidth="2" strokeLinecap="round" />
        <circle cx="106" cy="9" r="1.4" fill="#5c3f22" />
        <g className="cowboy-loader-lasso">
          <ellipse cx="114" cy="5" rx="9" ry="6" transform="rotate(-15 114 5)" fill="none" stroke="url(#cowboy-rope)" strokeWidth="2.1" strokeLinecap="round" />
        </g>

        <line
          className="cowboy-loader-ground"
          x1="10"
          y1="88"
          x2="210"
          y2="88"
          stroke="#7a4d27"
          strokeWidth="1.5"
          strokeDasharray="4 6"
          opacity="0.4"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
