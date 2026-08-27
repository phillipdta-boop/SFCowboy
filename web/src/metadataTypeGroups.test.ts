import { describe, it, expect } from "vitest";
import { OBJECTS_AND_CHILD_COMPONENTS, OBJECTS_AND_CHILD_COMPONENTS_TYPES, expandTypeSelection } from "./metadataTypeGroups.js";

describe("expandTypeSelection", () => {
  it("expands the Objects & Child Components umbrella into its real metadata types", () => {
    const result = expandTypeSelection([OBJECTS_AND_CHILD_COMPONENTS]);
    expect(result).toEqual(expect.arrayContaining(OBJECTS_AND_CHILD_COMPONENTS_TYPES));
    expect(result).not.toContain(OBJECTS_AND_CHILD_COMPONENTS);
  });

  it("passes through ordinary type names unchanged", () => {
    const result = expandTypeSelection(["ApexClass", "Flow"]);
    expect(result).toEqual(expect.arrayContaining(["ApexClass", "Flow"]));
  });

  it("de-duplicates when the umbrella and one of its own constituent types are both selected", () => {
    const result = expandTypeSelection([OBJECTS_AND_CHILD_COMPONENTS, "CustomField"]);
    expect(result.filter((t) => t === "CustomField")).toHaveLength(1);
  });

  it("mixes the umbrella with ordinary types", () => {
    const result = expandTypeSelection(["ApexClass", OBJECTS_AND_CHILD_COMPONENTS]);
    expect(result).toEqual(expect.arrayContaining(["ApexClass", ...OBJECTS_AND_CHILD_COMPONENTS_TYPES]));
  });
});
