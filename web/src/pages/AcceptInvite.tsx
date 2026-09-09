import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { fetchInviteInfo, acceptInvite } from "../api/client.js";

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const [email, setEmail] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!token) return;
    fetchInviteInfo(token)
      .then((info) => setEmail(info.email))
      .catch((err) => setLoadError((err as Error).message));
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSubmitError(null);
    setSubmitting(true);
    try {
      await acceptInvite(token, password);
      window.location.href = "/";
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitting(false);
    }
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
        <input
          id="invite-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          autoFocus
        />
        <button type="submit" disabled={submitting}>
          Set password
        </button>
      </form>
    </div>
  );
}
