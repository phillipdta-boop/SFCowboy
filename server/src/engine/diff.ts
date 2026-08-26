import path from "node:path";
import { diffLines } from "diff";
import type { ComponentRef } from "./orgComponents.js";

export interface DiffItem {
  type: string;
  fullName: string;
  status: "added" | "modified" | "removed" | "unchanged";
  lastModifiedDate?: string;
  lastModifiedByName?: string;
}

function key(c: ComponentRef): string {
  return `${c.type}::${c.fullName}`;
}

// For added/modified/unchanged, the source's own modified info is shown (that's the version being
// deployed); for removed, only the target has ever known about the component, so its info is used.
function itemFrom(c: ComponentRef, status: DiffItem["status"]): DiffItem {
  return { type: c.type, fullName: c.fullName, status, lastModifiedDate: c.lastModifiedDate, lastModifiedByName: c.lastModifiedByName };
}

export function diffComponents(source: ComponentRef[], target: ComponentRef[]): DiffItem[] {
  const targetMap = new Map(target.map((c) => [key(c), c]));
  const sourceMap = new Map(source.map((c) => [key(c), c]));
  const results: DiffItem[] = [];

  for (const s of source) {
    const t = targetMap.get(key(s));
    if (!t) {
      results.push(itemFrom(s, "added"));
    } else if (!s.lastModifiedDate || !t.lastModifiedDate) {
      results.push(itemFrom(s, "modified"));
    } else if (s.lastModifiedDate !== t.lastModifiedDate) {
      results.push(itemFrom(s, "modified"));
    } else {
      results.push(itemFrom(s, "unchanged"));
    }
  }
  for (const t of target) {
    if (!sourceMap.has(key(t))) {
      results.push(itemFrom(t, "removed"));
    }
  }
  return results;
}

export interface FileDiff {
  path: string;
  changes: { added?: boolean; removed?: boolean; value: string }[];
}

export function diffFileContents(
  sourceFiles: { path: string; content: string }[],
  targetFiles: { path: string; content: string }[]
): FileDiff[] {
  const targetByBasename = new Map(targetFiles.map((f) => [path.basename(f.path), f]));
  return sourceFiles.map((sf) => {
    const tf = targetByBasename.get(path.basename(sf.path));
    return { path: sf.path, changes: diffLines(tf?.content ?? "", sf.content) };
  });
}
