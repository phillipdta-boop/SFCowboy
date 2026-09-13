import { useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient.js";
import { Logo } from "../Logo.js";
import { ThemeToggle } from "../ThemeToggle.js";

// Reached two ways, both handled identically by this one page: (1) a password-reset email link
// (Login.tsx's "Forgot password?"), and (2) an admin-triggered reset email (Team.tsx). Either
// way, Supabase's client SDK auto-detects the recovery token in the URL fragment on page load and
// establishes a temporary session scoped to just this action -- updateUser({ password }) is the
// only call this page needs to make; it doesn't need to read the token itself.
export function ResetPassword() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setSubmitting(false);
      return;
    }
    window.location.href = "/";
  }

  return (
    <div className="auth-page">
      <ThemeToggle />
      <form className="auth-form" onSubmit={handleSubmit}>
        <Logo />
        <h1>Set a new password</h1>
        {error && <div className="error-banner">{error}</div>}
        <label htmlFor="reset-password">New password</label>
        <input id="reset-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
        <button type="submit" disabled={submitting}>
          Set new password
        </button>
      </form>
    </div>
  );
}
