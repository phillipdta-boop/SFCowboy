import { useState } from "react";
import { getInitialCowboyMode, applyCowboyMode, toggleCowboyMode } from "./cowboyMode.js";

export function CowboyModeToggle() {
  const [enabled, setEnabled] = useState<boolean>(() => {
    const initial = getInitialCowboyMode();
    applyCowboyMode(initial);
    return initial;
  });

  function handleClick() {
    setEnabled(toggleCowboyMode());
  }

  return (
    <button
      type="button"
      className={`cowboy-mode-toggle${enabled ? " active" : ""}`}
      onClick={handleClick}
      aria-pressed={enabled}
      aria-label={enabled ? "Turn off Cowboy Mode" : "Turn on Cowboy Mode"}
      title={enabled ? "Turn off Cowboy Mode" : "Turn on Cowboy Mode"}
    >
      🤠
    </button>
  );
}
