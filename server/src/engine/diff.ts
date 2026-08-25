import path from "node:path";
import { diffLines } from "diff";
import type { ComponentRef } from "./orgComponents.js";

export interface DiffItem {
  type: string;
  fullName: string;
  status: "added" | "modified" | "removed" | "unchanged";
}

function key(c: ComponentRef): string {
  return `${c.type}::${c.fullName}`;
}

export function diffComponents(source: ComponentRef[], target: ComponentRef[]): DiffItem[] {
  const targetMap = new Map(target.map((c) => [key(c), c]));
  const sourceMap = new Map(source.map((c) => [key(c), c]));
  const results: DiffItem[] = [];

  for (const s of source) {
    const t = targetMap.get(key(s));
    if (!t) {
      results.push({ type: s.type, fullName: s.fullName, status: "added" });
    } else if (!s.lastModifiedDate || !t.lastModifiedDate) {
      results.push({ type: s.type, fullName: s.fullName, status: "modified" });
    } else if (s.lastModifiedDate !== t.lastModifiedDate) {
      results.push({ type: s.type, fullName: s.fullName, status: "modified" });
    } else {
      results.push({ type: s.type, fullName: s.fullName, status: "unchanged" });
    }
  }
  for (const t of target) {
    if (!sourceMap.has(key(t))) {
      results.push({ type: t.type, fullName: t.fullName, status: "removed" });
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
