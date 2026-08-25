import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { ComponentSet, MetadataConverter } from "@salesforce/source-deploy-retrieve";

export async function convertZipToSourceDir(zipBuffer: Buffer, outputDir: string): Promise<void> {
  const mdapiDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-mdapi-"));
  new AdmZip(zipBuffer).extractAllTo(mdapiDir, true);

  const componentSet = ComponentSet.fromSource(mdapiDir);
  const converter = new MetadataConverter();
  await converter.convert(componentSet.getSourceComponents().toArray(), "source", {
    type: "directory",
    outputDirectory: outputDir,
  });

  fs.rmSync(mdapiDir, { recursive: true, force: true });
}

export async function convertSourceDirToZip(
  sourceDir: string,
  componentRefs: { type: string; fullName: string }[]
): Promise<Buffer> {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const wanted = new Set(componentRefs.map((c) => `${c.type}::${c.fullName}`));
  const selected = componentSet
    .getSourceComponents()
    .toArray()
    .filter((c) => wanted.has(`${c.type.name}::${c.fullName}`));

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-zip-"));
  const converter = new MetadataConverter();
  const { packagePath } = await converter.convert(selected, "metadata", { type: "zip", outputDirectory: outputDir });
  const zip = fs.readFileSync(packagePath!);
  fs.rmSync(outputDir, { recursive: true, force: true });
  return zip;
}
