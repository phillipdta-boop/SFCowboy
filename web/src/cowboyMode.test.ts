import { describe, it, expect, beforeEach } from "vitest";
import { COWBOY_MODE_STORAGE_KEY, COWBOY_MODE_CHANGE_EVENT, getInitialCowboyMode, applyCowboyMode, toggleCowboyMode } from "./cowboyMode.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-cowboy-mode");
});

describe("getInitialCowboyMode", () => {
  it("defaults to false when nothing is stored", () => {
    expect(getInitialCowboyMode()).toBe(false);
  });

  it("returns the stored preference", () => {
    localStorage.setItem(COWBOY_MODE_STORAGE_KEY, "true");
    expect(getInitialCowboyMode()).toBe(true);
  });
});

describe("applyCowboyMode", () => {
  it("sets data-cowboy-mode on the document root and persists to localStorage", () => {
    applyCowboyMode(true);
    expect(document.documentElement.getAttribute("data-cowboy-mode")).toBe("true");
    expect(localStorage.getItem(COWBOY_MODE_STORAGE_KEY)).toBe("true");
  });

  it("dispatches a change event so same-tab consumers can re-render", () => {
    let fired = false;
    window.addEventListener(COWBOY_MODE_CHANGE_EVENT, () => (fired = true), { once: true });
    applyCowboyMode(true);
    expect(fired).toBe(true);
  });
});

describe("toggleCowboyMode", () => {
  it("flips off to on and persists it", () => {
    applyCowboyMode(false);
    const next = toggleCowboyMode();
    expect(next).toBe(true);
    expect(document.documentElement.getAttribute("data-cowboy-mode")).toBe("true");
  });

  it("flips on to off and persists it", () => {
    applyCowboyMode(true);
    const next = toggleCowboyMode();
    expect(next).toBe(false);
    expect(document.documentElement.getAttribute("data-cowboy-mode")).toBe("false");
  });
});
