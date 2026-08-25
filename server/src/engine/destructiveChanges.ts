import AdmZip from "adm-zip";

/**
 * Builds a metadata-format deploy zip whose only instruction is "delete these components":
 * a `destructiveChanges.xml` naming them plus the empty `package.xml` the Metadata API requires
 * alongside it. Both entries sit at the zip ROOT, matching `deployZipToOrg`'s `singlePackage: true`.
 *
 * Shared by the forward deploy path (components the user selected with action "delete") and the
 * rollback path (undoing components the original deployment newly added).
 */
export function buildDestructiveChangesZip(components: { type: string; fullName: string }[]): Buffer {
  const byType = new Map<string, string[]>();
  for (const c of components) {
    if (!byType.has(c.type)) byType.set(c.type, []);
    byType.get(c.type)!.push(c.fullName);
  }
  const typesXml = Array.from(byType.entries())
    .map(
      ([name, members]) =>
        `  <types>\n${members.map((m) => `    <members>${m}</members>`).join("\n")}\n    <name>${name}</name>\n  </types>`
    )
    .join("\n");

  const destructiveChangesXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesXml}\n</Package>\n`;
  const emptyPackageXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <version>61.0</version>\n</Package>\n`;

  const zip = new AdmZip();
  zip.addFile("destructiveChanges.xml", Buffer.from(destructiveChangesXml));
  zip.addFile("package.xml", Buffer.from(emptyPackageXml));
  return zip.toBuffer();
}
