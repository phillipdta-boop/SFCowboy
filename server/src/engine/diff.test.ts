import { describe, it, expect } from "vitest";
import { diffComponents, diffFileContents } from "./diff.js";

describe("diffComponents", () => {
  it("classifies added, modified, removed, and unchanged components", () => {
    const source = [
      { type: "ApexClass", fullName: "OnlyInSource" },
      { type: "ApexClass", fullName: "Changed", lastModifiedDate: "2026-02-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "Same", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
    ];
    const target = [
      { type: "ApexClass", fullName: "Changed", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "Same", lastModifiedDate: "2026-01-01T00:00:00.000Z" },
      { type: "ApexClass", fullName: "OnlyInTarget" },
    ];

    const result = diffComponents(source, target);

    expect(result).toEqual(
      expect.arrayContaining([
        { type: "ApexClass", fullName: "OnlyInSource", status: "added" },
        { type: "ApexClass", fullName: "Changed", status: "modified" },
        { type: "ApexClass", fullName: "Same", status: "unchanged" },
        { type: "ApexClass", fullName: "OnlyInTarget", status: "removed" },
      ])
    );
  });

  it("treats components missing a lastModifiedDate (e.g. from git) as needing a content diff", () => {
    const source = [{ type: "ApexClass", fullName: "GitSourced" }];
    const target = [{ type: "ApexClass", fullName: "GitSourced", lastModifiedDate: "2026-01-01T00:00:00.000Z" }];
    const result = diffComponents(source, target);
    expect(result).toEqual([{ type: "ApexClass", fullName: "GitSourced", status: "modified" }]);
  });
});

describe("diffFileContents", () => {
  it("produces line-level changes between matched files", () => {
    const source = [{ path: "/src/classes/MyClass.cls", content: "public class MyClass {\n  Integer x = 2;\n}\n" }];
    const target = [{ path: "/retrieved/classes/MyClass.cls", content: "public class MyClass {\n  Integer x = 1;\n}\n" }];

    const result = diffFileContents(source, target);

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("/src/classes/MyClass.cls");
    expect(result[0].changes.some((c) => c.added && c.value.includes("x = 2"))).toBe(true);
    expect(result[0].changes.some((c) => c.removed && c.value.includes("x = 1"))).toBe(true);
  });
});
