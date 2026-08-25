import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { ComponentSet, MetadataConverter } from "@salesforce/source-deploy-retrieve";

const RETRIEVE_ROOT_PREFIX = "unpackaged/";

/**
 * Normalises a Metadata API *retrieve* zip into a root-rooted metadata-format zip.
 *
 * A retrieve nests everything under a single `unpackaged/` folder (SDR's own retrieve
 * extraction reads these zips with `zipTreeLocation: "unpackaged"`), but `deployZipToOrg`
 * issues the deploy with `singlePackage: true`, which requires `package.xml` at the zip ROOT.
 * Feeding a retrieve zip straight into that deploy fails against a real org.
 *
 * Returns the input buffer unchanged when nothing is prefixed, so it is safe (and a no-op) for
 * zips that are already root-rooted — e.g. the metadata-format zips `convertSourceDirToZip`
 * produces via SDR's MetadataConverter, and retrieve snapshots that were already normalised.
 */
export function stripUnpackagedPrefix(zipBuffer: Buffer): Buffer {
  const entries = new AdmZip(zipBuffer).getEntries();
  if (!entries.some((e) => e.entryName.startsWith(RETRIEVE_ROOT_PREFIX))) return zipBuffer;

  const out = new AdmZip();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.startsWith(RETRIEVE_ROOT_PREFIX)
      ? entry.entryName.slice(RETRIEVE_ROOT_PREFIX.length)
      : entry.entryName;
    if (!name) continue;
    out.addFile(name, entry.getData());
  }
  return out.toBuffer();
}

export async function convertZipToSourceDir(zipBuffer: Buffer, outputDir: string): Promise<void> {
  const mdapiDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfcowboy-mdapi-"));
  try {
    new AdmZip(zipBuffer).extractAllTo(mdapiDir, true);

    const componentSet = ComponentSet.fromSource(mdapiDir);
    const converter = new MetadataConverter();
    await converter.convert(componentSet.getSourceComponents().toArray(), "source", {
      type: "directory",
      outputDirectory: outputDir,
      // Without this SDR invents a `metadataPackage_<timestamp>` directory under outputDir, so
      // every run would land in a differently-named tree — fine for a throwaway conversion, wrong
      // for writing into a git clone's package directory, which must be a stable path.
      genUniqueDir: false,
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
