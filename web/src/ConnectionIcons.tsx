export function SalesforceIcon() {
  return (
    <svg className="connection-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M10.7 6.9c.8-.8 1.9-1.3 3.1-1.3 1.7 0 3.1 1 3.8 2.4.6-.3 1.3-.4 2-.4 2.5 0 4.4 2 4.4 4.4s-2 4.4-4.4 4.4H6.9C4.7 16.4 3 14.7 3 12.5c0-1.9 1.3-3.4 3.1-3.8.4-1.5 1.7-2.6 3.3-2.6.5 0 .9.1 1.3.3z"
        fill="#00A1E0"
      />
    </svg>
  );
}

export function GitHubIcon() {
  return (
    <svg className="connection-icon" width="22" height="22" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// The Connections page keys off addMode ("org"/"git"); everywhere else keys off the connection's
// own `type` field ("org"/"git") — same two icons, different callers.
export function ConnectionTypeIcon({ type }: { type: "org" | "git" }) {
  return type === "git" ? <GitHubIcon /> : <SalesforceIcon />;
}
