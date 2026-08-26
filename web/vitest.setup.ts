import "@testing-library/jest-dom/vitest";

// jsdom does not implement matchMedia; default to "no preference" so any component using it
// (e.g. dark-mode detection) doesn't crash in tests that don't care about it.
if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
