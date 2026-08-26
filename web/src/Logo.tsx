export function Logo() {
  return (
    <div className="app-logo" aria-label="SF Cowboy">
      <svg width="28" height="28" viewBox="0 0 64 64" role="img" aria-hidden="true">
        <ellipse cx="32" cy="44" rx="26" ry="7" fill="var(--logo-hat, #8a5a2b)" />
        <path
          d="M18 40 C18 24 24 12 32 12 C40 12 46 24 46 40 Z"
          fill="var(--logo-hat-crown, #a56b34)"
        />
        <ellipse cx="32" cy="40" rx="10" ry="4" fill="var(--logo-hat-band, #5c3a1a)" />
      </svg>
      <span className="app-logo-text">SF Cowboy</span>
    </div>
  );
}
