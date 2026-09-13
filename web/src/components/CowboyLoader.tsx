// A filled, shaded gallop loop for Cowboy Mode's loading state -- solid silhouettes with gradient
// shading and a ground shadow read as far more dimensional than a thin-stroke line figure, without
// needing a real illustrated asset.
export function CowboyLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="cowboy-loader" role="status" aria-label={label}>
      <svg viewBox="0 0 170 110" width="170" height="110" aria-hidden="true">
        <defs>
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
            <stop offset="0%" stopColor="#000000" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#000000" stopOpacity="0" />
          </radialGradient>
        </defs>

        <ellipse className="cowboy-loader-shadow" cx="80" cy="96" rx="55" ry="7" fill="url(#cowboy-shadow)" />

        <g className="cowboy-loader-legs-back" fill="url(#cowboy-horse-leg)">
          <path d="M38 66 Q33 66 32 71 L28 89 Q27 93 31 93 L38 93 Q41 93 41 89 L43 69 Q43 66 38 66 Z" />
          <path d="M56 68 Q51 68 50 73 L48 89 Q47 93 51 93 L58 93 Q61 93 61 89 L62 71 Q62 68 56 68 Z" />
        </g>

        <g className="cowboy-loader-body">
          <path fill="#4a2e17" d="M28 58 Q16 61 14 73 Q13 81 18 87 Q17 75 24 67 Q27 62 28 58 Z" />
          <path
            fill="url(#cowboy-horse-body)"
            d="M32 68
               C22 68 17 60 21 50
               C25 38 42 30 62 30
               C77 30 89 36 96 46
               C103 39 112 27 122 19
               C125 15 130 13 132 17
               C129 21 126 22 127 25
               C136 29 145 35 149 41
               C151 44 149 47 145 47
               C139 47 133 45 129 49
               C123 53 117 55 109 57
               C101 61 97 65 91 69
               L32 69 Z"
          />
        </g>

        <g className="cowboy-loader-legs-front" fill="url(#cowboy-horse-leg)">
          <path d="M84 70 Q79 70 78 75 L75 91 Q74 95 78 95 L85 95 Q88 95 88 91 L89 74 Q89 70 84 70 Z" />
          <path d="M100 68 Q95 68 94 73 L92 90 Q91 94 95 94 L102 94 Q105 94 105 90 L106 72 Q106 68 100 68 Z" />
        </g>

        <g className="cowboy-loader-rider">
          {/* Trailing leg */}
          <path fill="#33547a" d="M82 48 Q90 52 92 60 Q88 64 83 62 Q80 55 82 48 Z" />
          {/* Torso */}
          <path fill="url(#cowboy-shirt)" d="M64 22 Q60 32 64 44 Q72 48 80 44 Q82 32 76 22 Q70 18 64 22 Z" />
          {/* Arm raised to the lasso */}
          <path fill="#4f7cac" d="M76 26 Q86 20 92 12 Q95 14 93 18 Q88 26 80 32 Q76 30 76 26 Z" />
          {/* Head */}
          <circle cx="62" cy="18" r="7" fill="#dba25a" />
          {/* Hat */}
          <ellipse cx="61" cy="12" rx="12" ry="3.5" fill="url(#cowboy-hat)" />
          <path fill="url(#cowboy-hat)" d="M54 6 Q61 0 68 6 Q67 11 61 11 Q55 11 54 6 Z" />
        </g>

        <g className="cowboy-loader-lasso">
          <circle cx="92" cy="12" r="13" fill="none" stroke="#c9a15c" strokeWidth="3" strokeLinecap="round" />
        </g>
        <line x1="83" y1="20" x2="91" y2="13" stroke="#c9a15c" strokeWidth="2.5" strokeLinecap="round" />

        <line
          className="cowboy-loader-ground"
          x1="8"
          y1="96"
          x2="162"
          y2="96"
          stroke="currentColor"
          strokeWidth="2"
          strokeDasharray="4 6"
          opacity="0.25"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}
