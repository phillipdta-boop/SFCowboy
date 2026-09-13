import { useEffect, useState } from "react";
import { getInitialCowboyMode, COWBOY_MODE_CHANGE_EVENT } from "./cowboyMode.js";

// Lets any component re-render when Cowboy Mode is toggled, in this tab or another -- storage
// events only cover other tabs, hence the custom event cowboyMode.ts also dispatches.
export function useCowboyMode(): boolean {
  const [enabled, setEnabled] = useState(getInitialCowboyMode);

  useEffect(() => {
    function sync() {
      setEnabled(getInitialCowboyMode());
    }
    window.addEventListener("storage", sync);
    window.addEventListener(COWBOY_MODE_CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(COWBOY_MODE_CHANGE_EVENT, sync);
    };
  }, []);

  return enabled;
}
