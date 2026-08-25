import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listGitComponents, readGitComponentFiles } from "./gitComponents.js";

let projectDir: string;

beforeAll(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-source-"));
  fs.writeFileSync(
    path.join(projectDir, "sfdx-project.json"),
    JSON.stringify({ packageDirectories: [{ path: "force-app", default: true }], sourceApiVersion: "61.0" })
  );
  const classesDir = path.join(projectDir, "force-app", "main", "default", "classes");
  fs.mkdirSync(classesDir, { recursive: true });
  fs.writeFileSync(path.join(classesDir, "MyClass.cls"), "public class MyClass {}");
  fs.writeFileSync(
    path.join(classesDir, "MyClass.cls-meta.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>61.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`
  );
});

afterAll(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe("listGitComponents", () => {
  it("finds components in an SFDX source-format project", () => {
    const components = listGitComponents(projectDir);
    expect(components).toEqual(expect.arrayContaining([{ type: "ApexClass", fullName: "MyClass" }]));
  });
});

describe("readGitComponentFiles", () => {
  it("returns file contents for a component", () => {
    const files = readGitComponentFiles(projectDir, "ApexClass", "MyClass");
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.content.includes("public class MyClass"))).toBe(true);
  });
});
