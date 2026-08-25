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

const APEX_BODY = "public class MyClass {}";
const APEX_META = `<?xml version="1.0" encoding="UTF-8"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n  <apiVersion>61.0</apiVersion>\n  <status>Active</status>\n</ApexClass>\n`;

// A CustomObject with a custom field is genuinely restructured between mdapi and source
// format: mdapi stores it as a single flat `objects/MyObject__c.object` file with the field
// nested inline under a <fields> element, while source format decomposes it into
// `objects/MyObject__c/MyObject__c.object-meta.xml` (object only) plus a separate
// `objects/MyObject__c/fields/MyField__c.field-meta.xml` (the field). This was verified
// directly against the installed @salesforce/source-deploy-retrieve@12.7.4 by running a
// real conversion and inspecting the output tree (not assumed).
const CUSTOM_OBJECT_MDAPI = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
  <label>My Object</label>
  <pluralLabel>My Objects</pluralLabel>
  <nameField>
    <label>My Object Name</label>
    <type>Text</type>
  </nameField>
  <deploymentStatus>Deployed</deploymentStatus>
  <sharingModel>ReadWrite</sharingModel>
  <fields>
    <fullName>MyField__c</fullName>
    <label>My Field</label>
    <type>Text</type>
    <length>100</length>
  </fields>
</CustomObject>
`;

function buildFixtureMdapiZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    "package.xml",
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>MyClass</members>\n    <name>ApexClass</name>\n  </types>\n  <types>\n    <members>MyObject__c</members>\n    <name>CustomObject</name>\n  </types>\n  <version>61.0</version>\n</Package>\n`
    )
  );
  zip.addFile("classes/MyClass.cls", Buffer.from(APEX_BODY));
  zip.addFile("classes/MyClass.cls-meta.xml", Buffer.from(APEX_META));
  zip.addFile("objects/MyObject__c.object", Buffer.from(CUSTOM_OBJECT_MDAPI));
  return zip.toBuffer();
}

function findFile(rootDir: string, predicate: (relPath: string) => boolean): string | undefined {
  const all = fs.readdirSync(rootDir, { recursive: true } as any).map(String);
  const match = all.find(predicate);
  return match ? path.join(rootDir, match) : undefined;
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

  it("preserves apex class file content byte-for-byte through the conversion", async () => {
    const outputDir = path.join(workDir, "source-content-apex");
    await convertZipToSourceDir(buildFixtureMdapiZip(), outputDir);

    const clsPath = findFile(outputDir, (f) => f.endsWith("MyClass.cls") && !f.endsWith("-meta.xml"));
    expect(clsPath).toBeDefined();
    expect(fs.readFileSync(clsPath!, "utf8")).toBe(APEX_BODY);
  });

  it("decomposes a CustomObject's mdapi flat file into source-format object + field subdirectory, preserving content", async () => {
    const outputDir = path.join(workDir, "source-content-object");
    await convertZipToSourceDir(buildFixtureMdapiZip(), outputDir);

    // Real format-transformation: source format splits the single mdapi .object file into
    // an object-meta.xml (no <fields>) plus a separate field-meta.xml under fields/.
    const objectMetaPath = findFile(outputDir, (f) => f.endsWith(path.join("MyObject__c", "MyObject__c.object-meta.xml")));
    const fieldMetaPath = findFile(
      outputDir,
      (f) => f.endsWith(path.join("MyObject__c", "fields", "MyField__c.field-meta.xml"))
    );
    expect(objectMetaPath).toBeDefined();
    expect(fieldMetaPath).toBeDefined();

    const objectContent = fs.readFileSync(objectMetaPath!, "utf8");
    expect(objectContent).toContain("<label>My Object</label>");
    expect(objectContent).toContain("<deploymentStatus>Deployed</deploymentStatus>");
    // The field should have been extracted out of the object file, not left inline.
    expect(objectContent).not.toContain("MyField__c");

    const fieldContent = fs.readFileSync(fieldMetaPath!, "utf8");
    expect(fieldContent).toContain("<fullName>MyField__c</fullName>");
    expect(fieldContent).toContain("<label>My Field</label>");
    expect(fieldContent).toContain("<type>Text</type>");
    expect(fieldContent).toContain("<length>100</length>");
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

  it("preserves apex class content through a full round trip (mdapi -> source -> mdapi)", async () => {
    const sourceOutputDir = path.join(workDir, "source-for-zip-content-apex");
    await convertZipToSourceDir(buildFixtureMdapiZip(), sourceOutputDir);

    const zipBuffer = await convertSourceDirToZip(sourceOutputDir, [{ type: "ApexClass", fullName: "MyClass" }]);
    const zip = new AdmZip(zipBuffer);
    const clsEntry = zip.getEntries().find((e) => e.entryName.endsWith("MyClass.cls"));
    expect(clsEntry).toBeDefined();
    expect(zip.readAsText(clsEntry!)).toBe(APEX_BODY);
  });

  it("recomposes a CustomObject and its field back into mdapi format, preserving field content", async () => {
    const sourceOutputDir = path.join(workDir, "source-for-zip-content-object");
    await convertZipToSourceDir(buildFixtureMdapiZip(), sourceOutputDir);

    const zipBuffer = await convertSourceDirToZip(sourceOutputDir, [{ type: "CustomObject", fullName: "MyObject__c" }]);
    const zip = new AdmZip(zipBuffer);
    const objectEntry = zip.getEntries().find((e) => e.entryName.endsWith("MyObject__c.object"));
    expect(objectEntry).toBeDefined();

    const objectContent = zip.readAsText(objectEntry!);
    expect(objectContent).toContain("<label>My Object</label>");
    // The field must be recomposed back inline into the single mdapi-format file.
    expect(objectContent).toContain("<fullName>MyField__c</fullName>");
    expect(objectContent).toContain("<label>My Field</label>");
    expect(objectContent).toContain("<length>100</length>");
  });

  it("throws a descriptive error when a requested component is not found in the source directory", async () => {
    const sourceOutputDir = path.join(workDir, "source-for-zip-missing");
    await convertZipToSourceDir(buildFixtureMdapiZip(), sourceOutputDir);

    await expect(
      convertSourceDirToZip(sourceOutputDir, [
        { type: "ApexClass", fullName: "MyClass" },
        { type: "ApexClass", fullName: "DoesNotExist" },
      ])
    ).rejects.toThrow(/DoesNotExist/);
  });
});
