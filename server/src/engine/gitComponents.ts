import fs from "node:fs";
import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import type { ComponentRef } from "./orgComponents.js";

export function listGitComponents(sourceDir: string): ComponentRef[] {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const refs: ComponentRef[] = [];
  for (const component of componentSet.getSourceComponents()) {
    refs.push({ type: component.type.name, fullName: component.fullName });
  }
  return refs;
}

export function readGitComponentFiles(
  sourceDir: string,
  type: string,
  fullName: string
): { path: string; content: string }[] {
  const componentSet = ComponentSet.fromSource(sourceDir);
  const files: { path: string; content: string }[] = [];

  for (const component of componentSet.getSourceComponents()) {
    if (component.type.name !== type || component.fullName !== fullName) continue;

    for (const filePath of component.walkContent()) {
      files.push({ path: filePath, content: fs.readFileSync(filePath, "utf-8") });
    }
    if (component.xml) {
      files.push({ path: component.xml, content: fs.readFileSync(component.xml, "utf-8") });
    }
  }
  return files;
}
