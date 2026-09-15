import { useEffect, useState } from "react";

// Lifted out of StandardLoader so Cowboy Mode's loader can cycle its own wording on the same
// cadence. Cowboy Mode previously showed no message at all, which made it the only loading state
// in the app with nothing to read while you wait.
export function useLoadingMessages(messages: readonly string[], intervalMs = 1800): [string, number] {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % messages.length);
    }, intervalMs);
    return () => clearInterval(interval);
  }, [messages, intervalMs]);

  return [messages[index], index];
}
