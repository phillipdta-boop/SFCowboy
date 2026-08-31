import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { analyzeApexZip } from "./staticAnalysis.js";

function zipWith(files: { path: string; content: string }[]): Buffer {
  const zip = new AdmZip();
  for (const f of files) zip.addFile(f.path, Buffer.from(f.content));
  return zip.toBuffer();
}

describe("analyzeApexZip", () => {
  it("returns no findings for a zip with no Apex files", () => {
    const zip = zipWith([{ path: "objects/Account.object", content: "<xml/>" }]);
    expect(analyzeApexZip(zip)).toEqual([]);
  });

  it("returns no findings for clean Apex", () => {
    const zip = zipWith([
      {
        path: "classes/Clean.cls",
        content: [
          "public with sharing class Clean {",
          "    public void run() {",
          "        List<Account> accounts = [SELECT Id FROM Account];",
          "        for (Account a : accounts) {",
          "            a.Name = 'updated';",
          "        }",
          "        update accounts;",
          "        try {",
          "            doSomething();",
          "        } catch (Exception e) {",
          "            System.debug(e);",
          "        }",
          "    }",
          "}",
        ].join("\n"),
      },
    ]);
    expect(analyzeApexZip(zip)).toEqual([]);
  });

  describe("SOQL/DML in a loop", () => {
    it("flags a SOQL query inside a for loop", () => {
      const zip = zipWith([
        {
          path: "classes/Bad.cls",
          content: ["public class Bad {", "    void run() {", "        for (Integer i = 0; i < 10; i++) {", "            List<Account> a = [SELECT Id FROM Account];", "        }", "    }", "}"].join(
            "\n"
          ),
        },
      ]);
      const findings = analyzeApexZip(zip);
      expect(findings).toContainEqual(
        expect.objectContaining({ file: "classes/Bad.cls", rule: "soql-dml-in-loop", line: 4 })
      );
    });

    it("flags a DML statement inside a while loop", () => {
      const zip = zipWith([
        {
          path: "classes/Bad.cls",
          content: ["public class Bad {", "    void run() {", "        while (true) {", "            insert new Account();", "        }", "    }", "}"].join("\n"),
        },
      ]);
      const findings = analyzeApexZip(zip);
      expect(findings).toContainEqual(expect.objectContaining({ rule: "soql-dml-in-loop", line: 4 }));
    });

    it("does not flag a SOQL query outside any loop", () => {
      const zip = zipWith([
        {
          path: "classes/Clean.cls",
          content: [
            "public with sharing class Clean {",
            "    void run() {",
            "        List<Account> a = [SELECT Id FROM Account];",
            "        for (Integer i = 0; i < 10; i++) {",
            "            System.debug(i);",
            "        }",
            "    }",
            "}",
          ].join("\n"),
        },
      ]);
      expect(analyzeApexZip(zip)).toEqual([]);
    });
  });

  describe("hardcoded Salesforce ID", () => {
    it("flags a quoted 18-character alphanumeric literal", () => {
      const zip = zipWith([
        { path: "classes/Bad.cls", content: "public class Bad {\n    String id = '001000000000AAABBB';\n}" },
      ]);
      const findings = analyzeApexZip(zip);
      expect(findings).toContainEqual(expect.objectContaining({ rule: "hardcoded-id", line: 2 }));
    });

    it("flags a quoted 15-character alphanumeric literal", () => {
      const zip = zipWith([{ path: "classes/Bad.cls", content: "String id = '001000000000AAA';" }]);
      const findings = analyzeApexZip(zip);
      expect(findings).toContainEqual(expect.objectContaining({ rule: "hardcoded-id" }));
    });

    it("does not flag an ordinary short string literal", () => {
      const zip = zipWith([{ path: "classes/Clean.cls", content: "String name = 'Acme Corp';" }]);
      expect(analyzeApexZip(zip)).toEqual([]);
    });
  });

  describe("missing sharing declaration", () => {
    it("flags a public top-level class with no sharing keyword", () => {
      const zip = zipWith([{ path: "classes/Bad.cls", content: "public class Bad {\n}" }]);
      const findings = analyzeApexZip(zip);
      expect(findings).toContainEqual(expect.objectContaining({ rule: "missing-sharing", line: 1 }));
    });

    it("does not flag a class declared with sharing", () => {
      const zip = zipWith([{ path: "classes/Clean.cls", content: "public with sharing class Clean {\n}" }]);
      expect(analyzeApexZip(zip)).toEqual([]);
    });

    it("does not flag a class declared without sharing (explicit is still a decision)", () => {
      const zip = zipWith([{ path: "classes/Clean.cls", content: "public without sharing class Clean {\n}" }]);
      expect(analyzeApexZip(zip)).toEqual([]);
    });

    it("does not flag a class declared with inherited sharing", () => {
      const zip = zipWith([{ path: "classes/Clean.cls", content: "public inherited sharing class Clean {\n}" }]);
      expect(analyzeApexZip(zip)).toEqual([]);
    });
  });

  describe("empty catch block", () => {
    it("flags a catch block with no statements", () => {
      const zip = zipWith([
        { path: "classes/Bad.cls", content: "public class Bad {\n    void run() {\n        try {\n            doIt();\n        } catch (Exception e) {\n        }\n    }\n}" },
      ]);
      const findings = analyzeApexZip(zip);
      expect(findings).toContainEqual(expect.objectContaining({ rule: "empty-catch", line: 5 }));
    });

    it("does not flag a catch block that handles the exception", () => {
      const zip = zipWith([
        { path: "classes/Clean.cls", content: "try {\n    doIt();\n} catch (Exception e) {\n    System.debug(e);\n}" },
      ]);
      expect(analyzeApexZip(zip)).toEqual([]);
    });
  });

  it("scans both .cls and .trigger files, and reports each finding's own file", () => {
    const zip = zipWith([
      { path: "classes/BadClass.cls", content: "public class BadClass {\n}" },
      { path: "triggers/BadTrigger.trigger", content: "trigger BadTrigger on Account (before insert) {\n    for (Account a : Trigger.new) {\n        insert new Contact();\n    }\n}" },
    ]);
    const findings = analyzeApexZip(zip);
    expect(findings.some((f) => f.file === "classes/BadClass.cls" && f.rule === "missing-sharing")).toBe(true);
    expect(findings.some((f) => f.file === "triggers/BadTrigger.trigger" && f.rule === "soql-dml-in-loop")).toBe(true);
  });
});
