import AdmZip from "adm-zip";

export interface StaticAnalysisFinding {
  file: string;
  line: number;
  rule: "soql-dml-in-loop" | "hardcoded-id" | "missing-sharing" | "empty-catch";
  message: string;
}

const DML_OR_SOQL = /\b(insert|update|delete|upsert|undelete)\s|\[\s*SELECT\b|\[\s*FIND\b/i;
const LOOP_START = /\b(for|while)\s*\(|\bdo\s*\{/;
const HARDCODED_ID = /'([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})'/;
const CLASS_DECL = /^\s*(public|global|private)\s+(?:(?:with|without|inherited)\s+sharing\s+)?(?:abstract\s+|virtual\s+)?class\s+\w+/;
const HAS_SHARING = /\b(with|without|inherited)\s+sharing\b/;
const EMPTY_CATCH = /catch\s*\([^)]*\)\s*\{\s*\}/;

// Finds the line (1-indexed) a character offset falls on.
function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

/**
 * Basic, dependency-free Apex heuristics — not a real parser, so each rule is a pragmatic
 * approximation rather than a guarantee (see design notes on each function). Advisory only: a
 * finding never blocks or changes a deploy's outcome (see the coverage gate in deploy.ts for the
 * contrasting blocking case).
 */
function findSoqlDmlInLoops(content: string): Omit<StaticAnalysisFinding, "file">[] {
  const findings: Omit<StaticAnalysisFinding, "file">[] = [];
  const loopStarts = [...content.matchAll(new RegExp(LOOP_START, "g"))];
  for (const loopStart of loopStarts) {
    const braceOpen = content.indexOf("{", loopStart.index! + loopStart[0].length - 1);
    if (braceOpen === -1) continue;
    // Naive brace matching — good enough for well-formatted Apex, not brace-in-string-safe.
    let depth = 1;
    let i = braceOpen + 1;
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      i++;
    }
    const body = content.slice(braceOpen + 1, i - 1);
    const match = body.match(DML_OR_SOQL);
    if (match) {
      findings.push({
        line: lineAt(content, braceOpen + 1 + match.index!),
        rule: "soql-dml-in-loop",
        message: "SOQL query or DML statement inside a loop — can hit governor limits at scale.",
      });
    }
  }
  return findings;
}

function findHardcodedIds(content: string): Omit<StaticAnalysisFinding, "file">[] {
  const findings: Omit<StaticAnalysisFinding, "file">[] = [];
  for (const match of content.matchAll(new RegExp(HARDCODED_ID, "g"))) {
    findings.push({
      line: lineAt(content, match.index!),
      rule: "hardcoded-id",
      message: `Hardcoded Salesforce ID literal '${match[1]}' — record ids differ between orgs.`,
    });
  }
  return findings;
}

function findMissingSharing(content: string): Omit<StaticAnalysisFinding, "file">[] {
  const findings: Omit<StaticAnalysisFinding, "file">[] = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    if (CLASS_DECL.test(line) && !HAS_SHARING.test(line)) {
      findings.push({
        line: i + 1,
        rule: "missing-sharing",
        message: "Class has no explicit sharing declaration (with/without/inherited sharing).",
      });
    }
  });
  return findings;
}

function findEmptyCatches(content: string): Omit<StaticAnalysisFinding, "file">[] {
  const findings: Omit<StaticAnalysisFinding, "file">[] = [];
  for (const match of content.matchAll(new RegExp(EMPTY_CATCH, "g"))) {
    findings.push({
      line: lineAt(content, match.index!),
      rule: "empty-catch",
      message: "Empty catch block — the exception is silently swallowed.",
    });
  }
  return findings;
}

/** Runs every rule against a single Apex file's content, in source order. */
function analyzeApexFile(content: string): Omit<StaticAnalysisFinding, "file">[] {
  return [...findSoqlDmlInLoops(content), ...findHardcodedIds(content), ...findMissingSharing(content), ...findEmptyCatches(content)].sort(
    (a, b) => a.line - b.line
  );
}

/**
 * Scans every Apex class/trigger in a metadata-format zip (the same zip about to be deployed)
 * for a handful of well-known anti-patterns. Entirely text-based — no compiler, no external
 * process — so it's a basic pre-flight check, not a substitute for a real static analyzer.
 */
export function analyzeApexZip(zipBuffer: Buffer): StaticAnalysisFinding[] {
  const entries = new AdmZip(zipBuffer).getEntries();
  const findings: StaticAnalysisFinding[] = [];
  for (const entry of entries) {
    if (!entry.entryName.endsWith(".cls") && !entry.entryName.endsWith(".trigger")) continue;
    const content = entry.getData().toString("utf-8");
    for (const finding of analyzeApexFile(content)) {
      findings.push({ file: entry.entryName, ...finding });
    }
  }
  return findings;
}
