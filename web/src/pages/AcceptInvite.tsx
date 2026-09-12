import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "../supabaseClient.js";

// Reached from Supabase's own invite email link, which (like ResetPassword.tsx) establishes a
// temporary session client-side before this component even mounts. getUser() reads that session
// to show which address is being set up; updateUser({ password }) finalizes the account -- the
// underlying auth.users row (and its app_users row, via Task 2's trigger) already exists from the
// moment the admin sent the invite (team.ts's createInvite), so nothing here creates anything new.
export function AcceptInvite() {
  const [email, setEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    supabase.auth
      .getUser()
      .then(({ data }) => {
        if (!data.user?.email) {
          setLoadError("This invite link is invalid or has expired");
          return;
        }
        setEmail(data.user.email);
      })
      // A transient network error here previously left the user stuck on "Loading…" forever with
      // no error shown and no retry option -- surface the same message the "no user" branch above
      // already uses, rather than leaving them stranded.
      .catch(() => {
        setLoadError("This invite link is invalid or has expired");
      });
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setSubmitError(error.message);
      setSubmitting(false);
      return;
    }
    window.location.href = "/";
  }

  if (loadError) {
    return (
      <div className="auth-page">
        <div className="error-banner">{loadError}</div>
      </div>
    );
  }

  if (!email) {
    return <div className="auth-page">Loading…</div>;
  }

  return (
    <div className="auth-page">
      <form className="auth-form" onSubmit={handleSubmit}>
        <h1>Set your password</h1>
        <p>
          Creating an account for <strong>{email}</strong>
        </p>
        {submitError && <div className="error-banner">{submitError}</div>}
        <label htmlFor="invite-password">Password</label>
        <input id="invite-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required autoFocus />
        <button type="submit" disabled={submitting}>
          Set password
        </button>
      </form>
    </div>
  );
}
