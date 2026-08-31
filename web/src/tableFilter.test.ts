import { describe, it, expect } from "vitest";
import { matchesFilter } from "./tableFilter.js";

describe("matchesFilter", () => {
  it("matches a case-insensitive substring", () => {
    expect(matchesFilter("Sprint 12 release", "sprint")).toBe(true);
    expect(matchesFilter("Sprint 12 release", "RELEASE")).toBe(true);
  });

  it("does not match text that isn't present", () => {
    expect(matchesFilter("Sprint 12 release", "hotfix")).toBe(false);
  });

  it("treats a blank or whitespace-only filter as matching everything", () => {
    expect(matchesFilter("anything", "")).toBe(true);
    expect(matchesFilter("anything", "   ")).toBe(true);
  });

  it("ignores leading/trailing whitespace in the filter text", () => {
    expect(matchesFilter("Sprint 12 release", "  sprint  ")).toBe(true);
  });
});
