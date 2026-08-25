import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { convertZipToSourceDir, convertSourceDirToZip } from "./convert.js";

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-convert-"));
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function buildFixtureMdapiZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "package.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>MyClass</members>\n    <name>ApexClass</name>\n  </types>\n  <version>61.0</version>\n</Package>\n`
    )
  );
  zip.addFile("classes/MyClass.cls", Buffer.from("public class MyClass {}"));
  zip.addFile(
    "classes/MyClass.cls-meta.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>61.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`
    )
  );
  return zip.toBuffer();
}

describe("convertZipToSourceDir", () => {
  it("converts a retrieved mdapi zip into an SFDX source-format directory", async () => {
    const outputDir = path.join(workDir, "source-out");
    await convertZipToSourceDir(buildFixtureMdapiZip(), outputDir);

    const found = fs
      .readdirSync(outputDir, { recursive: true } as any)
      .map(String)
      .some((f) => f.includes("MyClass.cls"));
    expect(found).toBe(true);
  });
});

describe("convertSourceDirToZip", () => {
  it("converts selected components from an SFDX source directory into a deployable zip", async () => {
    const sourceOutputDir = path.join(workDir, "source-for-zip");
    await convertZipToSourceDir(buildFixtureMdapiZip(), sourceOutputDir);

    const zipBuffer = await convertSourceDirToZip(sourceOutputDir, [{ type: "ApexClass", fullName: "MyClass" }]);
    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((e) => e.entryName);

    expect(entryNames.some((n) => n.endsWith("MyClass.cls"))).toBe(true);
    expect(entryNames).toContain("package.xml");
  });
});
