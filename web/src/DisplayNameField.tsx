import { useState, type ChangeEvent } from "react";
import { getDisplayName, setDisplayName } from "./displayName.js";

/** A per-browser display name shown as "Run by" on deployments — attribution, not a login. */
export function DisplayNameField() {
  const [name, setName] = useState(() => getDisplayName());

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    setName(e.target.value);
    setDisplayName(e.target.value);
  }

  return (
    <input
      type="text"
      className="display-name-field"
      value={name}
      onChange={handleChange}
      placeholder="Your name"
      aria-label="Your name — labels deployments you run"
      title="Labels deployments you run as this browser's name. Not a login — anyone using this browser can change it."
    />
  );
}
