import { useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient.js";
import { Logo } from "../Logo.js";
import { ThemeToggle } from "../ThemeToggle.js";

// Mirrors server/src/config.ts's APP_BASE_URL default -- window.location.origin would embed
// whatever host happened to serve this page (e.g. localhost:3000 during local dev/testing), which
// is never reachable from an email opened somewhere else. Override via web/.env for local dev, the
// same way server/.env.example already documents for APP_BASE_URL.
const APP_BASE_URL = import.meta.env.VITE_APP_BASE_URL ?? "https://deploy.effluence.com.au";

export function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setError(error.message);
      setSubmitting(false);
      return;
    }
    window.location.href = "/";
  }

  async function handleForgotPassword() {
    if (!email) {
      setError("Enter your email above first, then click Forgot password?");
      return;
    }
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${APP_BASE_URL}/reset-password`,
    });
    if (error) {
      setError(error.message);
      return;
    }
    setResetSent(true);
  }

  if (resetSent) {
    return (
      <div className="auth-page">
        <ThemeToggle />
        <div className="auth-form">
          <Logo />
          <h1>Check your email</h1>
          <p>If an account exists for {email}, a password reset link has been sent.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <ThemeToggle />
      <form className="auth-form" onSubmit={handleSubmit}>
        <Logo />
        <h1>Log in</h1>
        {error && <div className="error-banner">{error}</div>}
        <label htmlFor="login-email">Email</label>
        <input id="login-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        <button type="submit" disabled={submitting}>
          Log in
        </button>
        <button type="button" onClick={handleForgotPassword}>
          Forgot password?
        </button>
      </form>
    </div>
  );
}
