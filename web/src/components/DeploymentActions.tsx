import { useState } from "react";
import { updateDeploymentTitle, deleteDeployment, cloneDeployment } from "../api/client.js";

export interface DeploymentActionsProps {
  deploymentId: string;
  title: string | null;
  onTitleChange: (title: string | null) => void;
  onCloned: (newDeploymentId: string) => void;
  onDeleted: () => void;
}

/**
 * Clone/Edit-title/Delete — actions that apply to a deployment regardless of its status, so
 * they're usable both while still editing a pending draft and after it's finished running.
 * Shared between DeploymentEditor (the pending case) and the deployment detail page's read-only
 * status view (everything else).
 */
export function DeploymentActions({ deploymentId, title, onTitleChange, onCloned, onDeleted }: DeploymentActionsProps) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setTitleDraft(title ?? "");
    setError(null);
    setEditing(true);
  }

  async function handleSaveTitle() {
    setBusy(true);
    setError(null);
    try {
      const next = titleDraft.trim() || null;
      await updateDeploymentTitle(deploymentId, next);
      onTitleChange(next);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleClone() {
    setBusy(true);
    setError(null);
    try {
      const { id } = await cloneDeployment(deploymentId);
      onCloned(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      // Reset even on success: onCloned/onDeleted usually navigates away and unmounts this
      // component, but nothing guarantees that happens synchronously, so leaving the buttons
      // stuck disabled until then would be a real (if narrow) UX bug.
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm("Delete this deployment? This cannot be undone.")) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDeployment(deploymentId);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="deployment-actions-wrap">
      {error && <p role="alert">{error}</p>}
      {editing ? (
        <div className="deployment-actions-edit">
          <input
            aria-label="Deployment title"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            placeholder="change summary ..."
            autoFocus
          />
          <button type="button" onClick={handleSaveTitle} disabled={busy}>
            Save
          </button>
          <button type="button" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="deployment-actions">
          <button type="button" onClick={handleClone} disabled={busy}>
            Clone
          </button>
          <button type="button" onClick={startEditing} disabled={busy}>
            Edit
          </button>
          <button type="button" onClick={handleDelete} disabled={busy}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
