import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { ComponentSet, MetadataConverter } from "@salesforce/source-deploy-retrieve";

export async function convertZipToSourceDir(zipBuffer: Buffer, outputDir: string): Promise<void> {
  const mdapiDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-mdapi-"));
  try {
    new AdmZip(zipBuffer).extractAllTo(mdapiDir, true);

    const componentSet = ComponentSet.fromSource(mdapiDir);
    const converter = new MetadataConverter();
    await converter.convert(componentSet.getSourceComponents().toArray(), "source", {
      type: "directory",
      outputDirectory: outputDir,
    });
  } finally {
    fs.rmSync(mdapiDir, { recursive: true, force: true });
  }
}

export async function convertSourceDirToZip(
  sourceDir: string,
  componentRefs: { type: string; fullName: string }[]
): Promise<Buffer> {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const wanted = new Map(componentRefs.map((c) => [`${c.type}::${c.fullName}`, c]));
  const matched = new Set<string>();
  const selected = componentSet
    .getSourceComponents()
    .toArray()
    .filter((c) => {
      const key = `${c.type.name}::${c.fullName}`;
      if (wanted.has(key)) {
        matched.add(key);
        return true;
      }
      return false;
    });

  const missing = [...wanted.keys()].filter((key) => !matched.has(key));
  if (missing.length > 0) {
    const missingRefs = missing.map((key) => wanted.get(key)!);
    throw new Error(
      `convertSourceDirToZip: component(s) not found in source directory: ${missingRefs
        .map((c) => `${c.type}:${c.fullName}`)
        .join(", ")}`
    );
  }

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-zip-"));
  try {
    const converter = new MetadataConverter();
    const { packagePath } = await converter.convert(selected, "metadata", { type: "zip", outputDirectory: outputDir });
    return fs.readFileSync(packagePath!);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
}
