import { describe, it, expect, beforeEach } from "vitest";
import { getDisplayName, setDisplayName } from "./displayName.js";

describe("displayName", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns an empty string when nothing has been set", () => {
    expect(getDisplayName()).toBe("");
  });

  it("stores and retrieves a trimmed name", () => {
    setDisplayName("  Phillip  ");
    expect(getDisplayName()).toBe("Phillip");
  });

  it("clears the stored name when set to blank", () => {
    setDisplayName("Phillip");
    setDisplayName("   ");
    expect(getDisplayName()).toBe("");
  });
});
